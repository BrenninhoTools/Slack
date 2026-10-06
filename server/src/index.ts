import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BotConfig, ClientEvent, ServerEvent } from '../../src/shared/protocol';
import * as bot from './bot';
import { createRequestHandler } from './http';
import { MediaStore } from './media';
import { Store, StoreError } from './store';

const PORT = Number(process.env.PORT ?? 3001);
const DATA_FILE = process.env.DATA_FILE === '' ? null : (process.env.DATA_FILE ?? 'data/slack.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(dirname(DATA_FILE ?? 'data/slack.json'), 'uploads');
/** Comma-separated usernames that moderate the Public Square. */
const ADMINS = new Set(
  (process.env.ADMIN_USERNAMES ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
);

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_EVENTS = 40;
const HEARTBEAT_MS = 30_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const ORPHAN_UPLOAD_MAX_AGE_MS = 60 * 60_000;

interface Client {
  ws: WebSocket;
  userId: string | null;
  token: string | null;
  alive: boolean;
  recent: number[];
}

const media = new MediaStore(UPLOAD_DIR);
const store = new Store(DATA_FILE, media, ADMINS);
/** Every open socket, authenticated or not. */
const sockets = new Map<WebSocket, Client>();
/** Authenticated clients grouped by user (one user can have several windows). */
const connections = new Map<string, Set<Client>>();

const http = createServer(createRequestHandler({ store, media, onlineUsers: () => connections.size }));
const wss = new WebSocketServer({ server: http, maxPayload: 16 * 1024 });

// ------------------------------------------------------------------ sending

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function sendToUser(userId: string, event: ServerEvent): void {
  connections.get(userId)?.forEach((c) => send(c.ws, event));
}

function sendToUsers(userIds: Iterable<string>, event: ServerEvent, exceptUserId?: string): void {
  for (const id of userIds) {
    if (id !== exceptUserId) sendToUser(id, event);
  }
}

function onlineAmong(userId: string): string[] {
  return [...store.audience(userId)].filter((id) => connections.has(id));
}

function broadcastGuild(guildId: string): void {
  sendToUsers(store.memberIdsOf(guildId), { type: 'guild_update', guild: store.getGuild(guildId) });
}

function broadcastMessage(channelId: string, message: ReturnType<Store['addBotMessage']>): void {
  sendToUsers(store.memberIdsOf(store.guildIdOfChannel(channelId)), { type: 'message_create', message });
}

function removeMember(guildId: string, userId: string, reason: 'kicked' | 'banned'): void {
  sendToUser(userId, { type: 'guild_remove', guildId, reason });
  broadcastGuild(guildId);
}

// ---------------------------------------------------------------------- bot

const botHooks: bot.BotHooks = {
  say(channelId, text) {
    broadcastMessage(channelId, store.addBotMessage(channelId, text));
  },
  guildChanged: broadcastGuild,
  memberRemoved: (guildId, userId, reason) => removeMember(guildId, userId, reason),
  messagesDeleted(channelId, messageIds) {
    const members = store.memberIdsOf(store.guildIdOfChannel(channelId));
    for (const messageId of messageIds) sendToUsers(members, { type: 'message_delete', channelId, messageId });
  },
  isOnline: (userId) => connections.has(userId)
};

// --------------------------------------------------------------------- auth

function authenticate(client: Client, userId: string, token: string): void {
  client.userId = userId;
  client.token = token;

  let set = connections.get(userId);
  if (!set) connections.set(userId, (set = new Set()));
  const firstConnection = set.size === 0;
  set.add(client);

  send(client.ws, { type: 'auth_ok', token, user: store.publicUser(userId) });
  send(client.ws, { type: 'ready', guilds: store.guildsFor(userId), online: onlineAmong(userId) });
  if (firstConnection) {
    sendToUsers(store.audience(userId), { type: 'presence_update', userId, online: true }, userId);
  }
}

function disconnect(client: Client): void {
  const { userId } = client;
  if (!userId) return;
  client.userId = null;
  const set = connections.get(userId);
  set?.delete(client);
  if (set && set.size === 0) {
    connections.delete(userId);
    sendToUsers(store.audience(userId), { type: 'presence_update', userId, online: false });
  }
}

// ----------------------------------------------------------------- handlers

function handle(client: Client, event: ClientEvent): void {
  switch (event.type) {
    case 'register': {
      requireAnonymous(client);
      const user = store.register(str(event.username), str(event.password));
      authenticate(client, user.id, store.createSession(user.id));
      return;
    }
    case 'login': {
      requireAnonymous(client);
      const user = store.login(str(event.username), str(event.password));
      authenticate(client, user.id, store.createSession(user.id));
      return;
    }
    case 'resume': {
      requireAnonymous(client);
      const token = str(event.token);
      authenticate(client, store.resume(token).id, token);
      return;
    }
  }

  const userId = client.userId;
  if (!userId) throw new StoreError('not_authenticated', 'Please log in first.');
  const notice = (message: string) => send(client.ws, { type: 'notice', message });

  switch (event.type) {
    case 'logout': {
      if (client.token) store.deleteSession(client.token);
      client.token = null;
      disconnect(client);
      return;
    }
    case 'update_profile': {
      const user = store.updateProfile(userId, {
        displayName: str(event.displayName),
        bio: str(event.bio),
        color: str(event.color),
        avatar: optionalId(event.avatar)
      });
      sendToUsers(store.audience(userId), { type: 'user_update', user });
      return;
    }
    case 'change_password': {
      store.changePassword(userId, str(event.currentPassword), str(event.newPassword), client.token);
      send(client.ws, { type: 'password_changed' });
      return;
    }

    // ------------------------------------------------------- communities
    case 'create_guild': {
      const guild = store.createGuild(userId, str(event.name));
      send(client.ws, { type: 'guild_create', guild, online: onlineAmong(userId) });
      return;
    }
    case 'join_guild': {
      const { guild, joined } = store.joinGuild(userId, str(event.inviteCode));
      send(client.ws, { type: 'guild_create', guild, online: onlineAmong(userId) });
      if (joined) {
        const others = store.memberIdsOf(guild.id);
        sendToUsers(others, { type: 'guild_update', guild }, userId);
        sendToUsers(others, { type: 'presence_update', userId, online: true }, userId);
        bot.welcome(store, botHooks, guild.id, store.publicUser(userId));
      }
      return;
    }
    case 'leave_guild': {
      const guildId = str(event.guildId);
      store.leaveGuild(userId, guildId);
      send(client.ws, { type: 'guild_remove', guildId, reason: 'left' });
      broadcastGuild(guildId);
      return;
    }
    case 'delete_guild': {
      const guildId = str(event.guildId);
      const members = store.deleteGuild(userId, guildId);
      sendToUsers(members, { type: 'guild_remove', guildId, reason: 'deleted' });
      return;
    }
    case 'update_guild': {
      const guildId = str(event.guildId);
      store.updateGuild(userId, guildId, {
        name: str(event.name),
        description: str(event.description),
        icon: optionalId(event.icon)
      });
      broadcastGuild(guildId);
      return;
    }
    case 'regenerate_invite': {
      const guildId = str(event.guildId);
      store.regenerateInvite(userId, guildId);
      broadcastGuild(guildId);
      return;
    }
    case 'create_channel': {
      const guild = store.createChannel(userId, str(event.guildId), str(event.name));
      broadcastGuild(guild.id);
      return;
    }
    case 'rename_channel': {
      const guild = store.renameChannel(userId, str(event.channelId), str(event.name));
      broadcastGuild(guild.id);
      return;
    }
    case 'delete_channel': {
      const guild = store.deleteChannel(userId, str(event.channelId));
      broadcastGuild(guild.id);
      return;
    }

    // ---------------------------------------------------------- messages
    case 'fetch_history': {
      const channelId = str(event.channelId);
      send(client.ws, { type: 'history', channelId, messages: store.history(userId, channelId) });
      return;
    }
    case 'send_message': {
      const channelId = str(event.channelId);
      const { guildId } = store.accessChannel(userId, channelId);
      const content = str(event.content);
      const attachmentIds = Array.isArray(event.attachmentIds) ? event.attachmentIds.map(str) : [];
      const sender = store.publicUser(userId);

      // A muted member gets the "muted" error from addMessage instead of being screened again.
      if (store.muteRemaining(guildId, userId) === 0) {
        const verdict = bot.screen(store, botHooks, guildId, channelId, sender, content);
        if (!verdict.ok) throw new StoreError('blocked', verdict.reason);
      }
      const message = store.addMessage(userId, channelId, content, attachmentIds);
      broadcastMessage(channelId, message);
      bot.handleCommand(store, botHooks, guildId, channelId, sender, content);
      return;
    }
    case 'delete_message': {
      const channelId = str(event.channelId);
      store.deleteMessage(userId, channelId, str(event.messageId));
      sendToUsers(store.memberIdsOf(store.guildIdOfChannel(channelId)), {
        type: 'message_delete',
        channelId,
        messageId: str(event.messageId)
      });
      return;
    }
    case 'typing': {
      const channelId = str(event.channelId);
      const { guildId } = store.accessChannel(userId, channelId);
      sendToUsers(
        store.memberIdsOf(guildId),
        { type: 'typing', channelId, user: store.publicUser(userId) },
        userId
      );
      return;
    }

    // -------------------------------------------------------- moderation
    case 'set_role': {
      const guildId = str(event.guildId);
      const role = event.role === 'moderator' ? 'moderator' : 'member';
      const targetId = str(event.userId);
      store.setRole(userId, guildId, targetId, role);
      broadcastGuild(guildId);
      notice(role === 'moderator' ? 'Member promoted to moderator.' : 'Moderator role removed.');
      return;
    }
    case 'kick': {
      const guildId = str(event.guildId);
      const targetId = str(event.userId);
      store.kick(userId, guildId, targetId);
      removeMember(guildId, targetId, 'kicked');
      notice('Member removed from the community.');
      return;
    }
    case 'ban': {
      const guildId = str(event.guildId);
      const targetId = str(event.userId);
      store.ban(userId, guildId, targetId, str(event.reason));
      removeMember(guildId, targetId, 'banned');
      notice('Member banned.');
      return;
    }
    case 'unban': {
      const guildId = str(event.guildId);
      store.unban(userId, guildId, str(event.userId));
      send(client.ws, { type: 'guild_settings', guildId, ...store.guildSettings(userId, guildId) });
      notice('Member unbanned.');
      return;
    }
    case 'mute': {
      const minutes = Number(event.minutes);
      store.mute(userId, str(event.guildId), str(event.userId), minutes);
      notice(minutes === 0 ? 'Mute lifted.' : `Member muted for ${minutes} minute(s).`);
      return;
    }
    case 'fetch_guild_settings': {
      const guildId = str(event.guildId);
      send(client.ws, { type: 'guild_settings', guildId, ...store.guildSettings(userId, guildId) });
      return;
    }
    case 'update_bot': {
      const guildId = str(event.guildId);
      store.updateBot(userId, guildId, (event.bot ?? {}) as BotConfig);
      broadcastGuild(guildId); // the bot appears in or disappears from the member list
      send(client.ws, { type: 'guild_settings', guildId, ...store.guildSettings(userId, guildId) });
      notice('Bot settings saved.');
      return;
    }
    default:
      throw new StoreError('bad_request', 'Unknown event.');
  }
}

function requireAnonymous(client: Client): void {
  if (client.userId) throw new StoreError('already_authenticated', 'You are already logged in.');
}

/** Coerces untrusted JSON fields to strings. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** undefined = leave unchanged, null = clear, string = an upload id. */
function optionalId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function rateLimited(client: Client): boolean {
  const now = Date.now();
  client.recent = client.recent.filter((t) => now - t < RATE_WINDOW_MS);
  client.recent.push(now);
  return client.recent.length > RATE_MAX_EVENTS;
}

// -------------------------------------------------------------- connections

wss.on('connection', (ws) => {
  const client: Client = { ws, userId: null, token: null, alive: true, recent: [] };
  sockets.set(ws, client);

  ws.on('pong', () => {
    client.alive = true;
  });

  ws.on('message', (data) => {
    try {
      if (rateLimited(client)) throw new StoreError('rate_limited', 'You are sending too many requests.');
      const event: unknown = JSON.parse(data.toString());
      if (typeof event !== 'object' || event === null || typeof (event as ClientEvent).type !== 'string') {
        throw new StoreError('bad_request', 'Malformed event.');
      }
      handle(client, event as ClientEvent);
    } catch (err) {
      if (err instanceof StoreError) {
        send(ws, { type: 'error', code: err.code, message: err.message });
      } else if (err instanceof SyntaxError) {
        send(ws, { type: 'error', code: 'bad_request', message: 'Invalid JSON.' });
      } else {
        console.error('[server] unexpected error:', err);
        send(ws, { type: 'error', code: 'bad_request', message: 'Something went wrong.' });
      }
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    disconnect(client);
  });
  ws.on('error', () => ws.terminate());
});

const heartbeat = setInterval(() => {
  for (const client of sockets.values()) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, HEARTBEAT_MS);

// Uploads that were never attached to a message, avatar or icon are removed after an hour.
const sweeper = setInterval(() => {
  const removed = store.sweepUploads(ORPHAN_UPLOAD_MAX_AGE_MS);
  if (removed > 0) console.log(`[server] removed ${removed} unused upload(s)`);
}, SWEEP_INTERVAL_MS);

// ----------------------------------------------------------------- lifecycle

http.listen(PORT, () => {
  console.log(`[server] Slack server listening on ws://localhost:${PORT}`);
  console.log(`[server] data file: ${DATA_FILE ?? '(in-memory only)'}  uploads: ${UPLOAD_DIR}`);
  if (ADMINS.size > 0) console.log(`[server] Public Square moderators: ${[...ADMINS].join(', ')}`);
});

function shutdown(): void {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  wss.close();
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
