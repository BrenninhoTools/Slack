import { randomInt } from 'node:crypto';
import type { PublicUser } from '../../src/shared/protocol';
import { StoreError, type Store } from './store';

/** What the bot needs from the server to act; implemented in index.ts where the sockets live. */
export interface BotHooks {
  /** Posts a message as the bot and broadcasts it to the channel's members. */
  say(channelId: string, text: string): void;
  /** Broadcasts the updated community to its members. */
  guildChanged(guildId: string): void;
  /** Tells a removed member and updates everyone else. */
  memberRemoved(guildId: string, userId: string, reason: 'kicked'): void;
  messagesDeleted(channelId: string, messageIds: string[]): void;
  isOnline(userId: string): boolean;
}

interface CommandContext {
  store: Store;
  hooks: BotHooks;
  guildId: string;
  channelId: string;
  sender: PublicUser;
  args: string[];
  isModerator: boolean;
}

const SPAM_WINDOW_MS = 8000;
const SPAM_MAX_MESSAGES = 6;
const SPAM_MUTE_MS = 60_000;
const WARNING_COOLDOWN_MS = 15_000;
const URL_RE = /(https?:\/\/|www\.)\S+/i;

const recentMessages = new Map<string, number[]>();
const lastWarning = new Map<string, number>();

// ---------------------------------------------------------------- welcome

export function welcome(store: Store, hooks: BotHooks, guildId: string, user: PublicUser): void {
  if (!store.botConfig(guildId).enabled || !store.botConfig(guildId).welcome) return;
  const guild = store.getGuild(guildId);
  const channel = guild.channels[0];
  if (!channel) return;
  hooks.say(channel.id, `Welcome to ${guild.name}, @${user.username}! Type /help to see what I can do.`);
}

// ----------------------------------------------------------- auto-moderation

export type ScreenResult = { ok: true } | { ok: false; reason: string };

/** Checks a message before it is posted. Moderators and owners are never screened. */
export function screen(
  store: Store,
  hooks: BotHooks,
  guildId: string,
  channelId: string,
  sender: PublicUser,
  content: string
): ScreenResult {
  const config = store.botConfig(guildId);
  if (!config.enabled || store.roleIn(guildId, sender.id) !== 'member') return { ok: true };

  const warn = (text: string) => {
    const key = `${guildId}:${sender.id}`;
    if (Date.now() - (lastWarning.get(key) ?? 0) < WARNING_COOLDOWN_MS) return;
    lastWarning.set(key, Date.now());
    hooks.say(channelId, text);
  };

  if (config.antiSpam) {
    const key = `${guildId}:${sender.id}`;
    const now = Date.now();
    const recent = (recentMessages.get(key) ?? []).filter((t) => now - t < SPAM_WINDOW_MS);
    recent.push(now);
    recentMessages.set(key, recent);
    if (recent.length > SPAM_MAX_MESSAGES) {
      recentMessages.delete(key);
      store.applyMute(guildId, sender.id, now + SPAM_MUTE_MS);
      hooks.say(channelId, `@${sender.username} was muted for 1 minute for sending messages too quickly.`);
      return { ok: false, reason: 'You are sending messages too quickly and were muted for 1 minute.' };
    }
  }

  if (config.blockLinks && URL_RE.test(content)) {
    warn(`@${sender.username}, links are not allowed in this community.`);
    return { ok: false, reason: 'Links are not allowed in this community.' };
  }

  const lowered = content.toLowerCase();
  if (config.blockedWords.some((word) => containsWord(lowered, word))) {
    warn(`@${sender.username}, please watch your language.`);
    return { ok: false, reason: 'Your message contains a word that is not allowed here.' };
  }
  return { ok: true };
}

/** Whole-word match that works for any script (\b only understands ASCII). */
function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

// ---------------------------------------------------------------- commands

type Command = { help: string; moderatorOnly?: boolean; run(ctx: CommandContext): void };

const COMMANDS: Record<string, Command> = {
  help: {
    help: 'Show this list',
    run: ({ hooks, channelId, isModerator }) => {
      const lines = Object.entries(COMMANDS)
        .filter(([, command]) => isModerator || !command.moderatorOnly)
        .map(([name, command]) => `/${name} — ${command.help}`);
      hooks.say(channelId, `Here is what I can do:\n${lines.join('\n')}`);
    }
  },
  ping: { help: 'Check that I am awake', run: ({ hooks, channelId }) => hooks.say(channelId, 'Pong!') },
  flip: {
    help: 'Flip a coin',
    run: ({ hooks, channelId }) => hooks.say(channelId, randomInt(2) === 0 ? 'Heads!' : 'Tails!')
  },
  roll: {
    help: 'Roll dice, e.g. /roll 2d6 (default 1d6)',
    run: ({ hooks, channelId, sender, args }) => {
      const match = /^(\d{1,2})?d(\d{1,4})$/i.exec(args[0] ?? 'd6');
      const count = Number(match?.[1] ?? 1);
      const sides = Number(match?.[2]);
      if (!match || count < 1 || count > 10 || sides < 2) {
        hooks.say(channelId, 'Use the form /roll 2d6 (up to 10 dice, 2-9999 sides).');
        return;
      }
      const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
      const total = rolls.reduce((a, b) => a + b, 0);
      hooks.say(channelId, `@${sender.username} rolled ${rolls.join(' + ')}${count > 1 ? ` = ${total}` : ''}`);
    }
  },
  members: {
    help: 'Show how many members are online',
    run: ({ store, hooks, guildId, channelId }) => {
      const members = store.getGuild(guildId).members.filter((m) => !m.bot);
      const online = members.filter((m) => hooks.isOnline(m.id)).length;
      hooks.say(channelId, `${members.length} member(s), ${online} online.`);
    }
  },
  purge: {
    help: 'Delete the last N messages, e.g. /purge 10',
    moderatorOnly: true,
    run: ({ store, hooks, channelId, args }) => {
      const count = Number(args[0]);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        hooks.say(channelId, 'Use /purge followed by a number from 1 to 100.');
        return;
      }
      // +1 also removes the command message itself.
      const ids = store.purge(channelId, count + 1);
      hooks.messagesDeleted(channelId, ids);
      hooks.say(channelId, `Deleted ${Math.max(0, ids.length - 1)} message(s).`);
    }
  },
  mute: {
    help: 'Mute a member, e.g. /mute @name 10 (minutes, default 10)',
    moderatorOnly: true,
    run: (ctx) => moderate(ctx, (target) => {
      const minutes = ctx.args[1] === undefined ? 10 : Number(ctx.args[1]);
      ctx.store.mute(ctx.sender.id, ctx.guildId, target.id, minutes);
      ctx.hooks.say(ctx.channelId, minutes === 0 ? `@${target.username} was unmuted.` : `@${target.username} was muted for ${minutes} minute(s).`);
    })
  },
  unmute: {
    help: 'Lift a mute, e.g. /unmute @name',
    moderatorOnly: true,
    run: (ctx) => moderate(ctx, (target) => {
      ctx.store.mute(ctx.sender.id, ctx.guildId, target.id, 0);
      ctx.hooks.say(ctx.channelId, `@${target.username} was unmuted.`);
    })
  },
  kick: {
    help: 'Remove a member (they can rejoin), e.g. /kick @name',
    moderatorOnly: true,
    run: (ctx) => moderate(ctx, (target) => {
      ctx.store.kick(ctx.sender.id, ctx.guildId, target.id);
      ctx.hooks.memberRemoved(ctx.guildId, target.id, 'kicked');
      ctx.hooks.say(ctx.channelId, `@${target.username} was removed from the community.`);
    })
  }
};

/** Resolves `@username` and runs a moderation action, reporting permission errors in the channel. */
function moderate(ctx: CommandContext, action: (target: PublicUser) => void): void {
  const name = (ctx.args[0] ?? '').replace(/^@/, '');
  const target = name ? ctx.store.memberByUsername(ctx.guildId, name) : undefined;
  if (!target) {
    ctx.hooks.say(ctx.channelId, 'Mention a member of this community, e.g. /mute @name.');
    return;
  }
  try {
    action(target);
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    ctx.hooks.say(ctx.channelId, err.message);
  }
}

/** Runs a slash command if the message is one. The message itself is still posted normally. */
export function handleCommand(
  store: Store,
  hooks: BotHooks,
  guildId: string,
  channelId: string,
  sender: PublicUser,
  content: string
): void {
  if (!content.startsWith('/') || !store.botConfig(guildId).enabled) return;
  const [rawName = '', ...args] = content.slice(1).trim().split(/\s+/);
  const command = COMMANDS[rawName.toLowerCase()];
  if (!command) return;

  const isModerator = store.roleIn(guildId, sender.id) !== 'member';
  if (command.moderatorOnly && !isModerator) {
    hooks.say(channelId, `@${sender.username}, only moderators can use /${rawName.toLowerCase()}.`);
    return;
  }
  command.run({ store, hooks, guildId, channelId, sender, args, isModerator });
}
