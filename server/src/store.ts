import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AVATAR_COLORS,
  DEFAULT_BOT_CONFIG,
  LIMITS,
  PUBLIC_GUILD_ID,
  type AttachmentDTO,
  type BanDTO,
  type BotConfig,
  type ChannelDTO,
  type ErrorCode,
  type GuildDTO,
  type MessageDTO,
  type ProfileUpdate,
  type PublicUser,
  type Role,
  type UploadKind
} from '../../src/shared/protocol';
import type { MediaStore } from './media';

interface UserRecord {
  id: string;
  username: string;
  salt: string;
  hash: string;
  createdAt: number;
  // Optional so data files written by older versions still load.
  displayName?: string;
  bio?: string;
  color?: string;
  avatar?: string | null;
}

interface BanRecord {
  userId: string;
  reason: string;
  at: number;
}

interface GuildRecord {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  memberIds: string[];
  channels: ChannelDTO[];
  description?: string;
  icon?: string | null;
  moderatorIds?: string[];
  bans?: BanRecord[];
  /** userId -> epoch ms when the mute ends. */
  mutes?: Record<string, number>;
  bot?: BotConfig;
}

type NormalizedGuild = Required<GuildRecord>;

interface MessageRecord {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  timestamp: number;
  attachments?: string[];
}

interface FileRecord {
  id: string;
  ownerId: string;
  kind: UploadKind;
  mime: string;
  size: number;
  name: string;
  width: number;
  height: number;
  createdAt: number;
  /** False until the file is used as an avatar, icon or message attachment. */
  attached: boolean;
}

interface Snapshot {
  users: UserRecord[];
  guilds: GuildRecord[];
  messages: MessageRecord[];
  sessions: Record<string, string>;
  files?: FileRecord[];
}

export class StoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export { PUBLIC_GUILD_ID };
export const BOT_ID = 'bot';
const SYSTEM_USER_ID = 'system';

/** The built-in moderation bot. It is not a real account and cannot log in. */
export const BOT_USER: PublicUser = {
  id: BOT_ID,
  username: 'Guardian',
  displayName: 'Guardian',
  bio: 'I keep communities tidy: welcome messages, auto-moderation and handy commands. Type /help.',
  color: '#14b8a6',
  avatar: null,
  bot: true
};

const RESERVED_NAMES = new Set(['guardian', 'system', 'admin', 'administrator', 'moderator', 'everyone', 'here']);
const HISTORY_PAGE = 50;
const MAX_MESSAGES_PER_CHANNEL = 1000;
const MAX_CHANNELS_PER_GUILD = 50;
const MAX_MUTE_MINUTES = 7 * 24 * 60;
const USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;
const CHANNEL_RE = /^[a-z0-9_-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

/** In-memory data store with debounced JSON persistence. */
export class Store {
  private users = new Map<string, UserRecord>();
  private userIdsByName = new Map<string, string>();
  private guilds = new Map<string, NormalizedGuild>();
  private messages = new Map<string, MessageRecord[]>();
  private sessions = new Map<string, string>();
  private files = new Map<string, FileRecord>();
  private saveTimer: NodeJS.Timeout | null = null;

  /**
   * @param file    JSON persistence file, or null for memory only
   * @param media   disk storage for uploaded images
   * @param admins  lower-case usernames that moderate the Public Square
   */
  constructor(
    private readonly file: string | null,
    private readonly media: MediaStore,
    private readonly admins: ReadonlySet<string> = new Set()
  ) {
    this.load();
    this.ensurePublicGuild();
  }

  // ---------------------------------------------------------------- users

  register(username: string, password: string): PublicUser {
    username = username.trim();
    if (
      username.length < LIMITS.usernameMin ||
      username.length > LIMITS.usernameMax ||
      !USERNAME_RE.test(username)
    ) {
      throw new StoreError(
        'bad_request',
        `Username must be ${LIMITS.usernameMin}-${LIMITS.usernameMax} characters: letters, numbers, "_", "." or "-".`
      );
    }
    this.validatePassword(password);
    if (RESERVED_NAMES.has(username.toLowerCase())) {
      throw new StoreError('username_taken', 'That username is reserved.');
    }
    if (this.userIdsByName.has(username.toLowerCase())) {
      throw new StoreError('username_taken', 'That username is already taken.');
    }

    const salt = randomBytes(16).toString('hex');
    const user: UserRecord = {
      id: randomUUID(),
      username,
      salt,
      hash: hashPassword(password, salt),
      createdAt: Date.now(),
      displayName: username,
      bio: '',
      color: AVATAR_COLORS[randomBytes(1)[0]! % AVATAR_COLORS.length],
      avatar: null
    };
    this.users.set(user.id, user);
    this.userIdsByName.set(username.toLowerCase(), user.id);
    this.guilds.get(PUBLIC_GUILD_ID)?.memberIds.push(user.id);
    this.scheduleSave();
    return this.publicUser(user.id);
  }

  login(username: string, password: string): PublicUser {
    const id = this.userIdsByName.get(username.trim().toLowerCase());
    const user = id ? this.users.get(id) : undefined;
    if (!user || !this.passwordMatches(user, password)) {
      throw new StoreError('invalid_credentials', 'Invalid username or password.');
    }
    return this.publicUser(user.id);
  }

  updateProfile(userId: string, update: ProfileUpdate): PublicUser {
    const user = this.requireUser(userId);
    const displayName = update.displayName.trim();
    const bio = update.bio.trim();
    if (!displayName || displayName.length > LIMITS.displayNameMax || CONTROL_CHARS_RE.test(displayName)) {
      throw new StoreError('bad_request', `Display name must be 1-${LIMITS.displayNameMax} characters.`);
    }
    if (bio.length > LIMITS.bioMax) {
      throw new StoreError('bad_request', `About me can be at most ${LIMITS.bioMax} characters.`);
    }
    if (!(AVATAR_COLORS as readonly string[]).includes(update.color)) {
      throw new StoreError('bad_request', 'Unknown avatar colour.');
    }
    // Claim the new photo last, so a failed update never consumes an upload.
    const avatar = this.swapFile(userId, user.avatar ?? null, update.avatar, 'avatar');

    user.displayName = displayName;
    user.bio = bio;
    user.color = update.color;
    user.avatar = avatar;
    this.scheduleSave();
    return this.publicUser(userId);
  }

  /** Changes the password and signs out every session except `keepToken`. */
  changePassword(userId: string, currentPassword: string, newPassword: string, keepToken: string | null): void {
    const user = this.requireUser(userId);
    if (!this.passwordMatches(user, currentPassword)) {
      throw new StoreError('invalid_credentials', 'Your current password is incorrect.');
    }
    this.validatePassword(newPassword);
    user.salt = randomBytes(16).toString('hex');
    user.hash = hashPassword(newPassword, user.salt);
    for (const [token, id] of this.sessions) {
      if (id === userId && token !== keepToken) this.sessions.delete(token);
    }
    this.scheduleSave();
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, userId);
    this.scheduleSave();
    return token;
  }

  resume(token: string): PublicUser {
    const userId = this.sessions.get(token);
    if (!userId || !this.users.has(userId)) {
      throw new StoreError('invalid_token', 'Your session has expired. Please log in again.');
    }
    return this.publicUser(userId);
  }

  deleteSession(token: string): void {
    if (this.sessions.delete(token)) this.scheduleSave();
  }

  publicUser(id: string): PublicUser {
    if (id === BOT_ID) return BOT_USER;
    const user = this.requireUser(id);
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? user.username,
      bio: user.bio ?? '',
      color: user.color ?? AVATAR_COLORS[0],
      avatar: user.avatar ?? null
    };
  }

  /** Finds a member of the guild by username (case-insensitive). */
  memberByUsername(guildId: string, username: string): PublicUser | undefined {
    const id = this.userIdsByName.get(username.trim().toLowerCase());
    return id && this.requireGuild(guildId).memberIds.includes(id) ? this.publicUser(id) : undefined;
  }

  // ---------------------------------------------------------------- roles

  roleOf(guild: GuildRecord, userId: string): Role {
    const g = guild as NormalizedGuild;
    if (g.ownerId === userId) return 'owner';
    if (g.moderatorIds.includes(userId)) return 'moderator';
    if (g.id === PUBLIC_GUILD_ID && this.isAdmin(userId)) return 'moderator';
    return 'member';
  }

  /** Role of a user in a guild (used by the bot to check who may run moderation commands). */
  roleIn(guildId: string, userId: string): Role {
    return this.roleOf(this.requireGuild(guildId), userId);
  }

  private isAdmin(userId: string): boolean {
    const username = this.users.get(userId)?.username.toLowerCase();
    return username !== undefined && this.admins.has(username);
  }

  private requireModerator(guild: GuildRecord, userId: string): void {
    if (this.roleOf(guild, userId) === 'member') {
      throw new StoreError('forbidden', 'Only moderators can do that.');
    }
  }

  private requireOwner(guild: GuildRecord, userId: string): void {
    if (guild.ownerId !== userId) throw new StoreError('forbidden', 'Only the community owner can do that.');
  }

  /** Moderators can act on members; only the owner can act on moderators; nobody acts on the owner or themself. */
  private requireCanModerate(guild: GuildRecord, actorId: string, targetId: string): void {
    this.requireModerator(guild, actorId);
    const target = this.roleOf(guild, targetId);
    const forbidden =
      actorId === targetId ||
      targetId === BOT_ID ||
      target === 'owner' ||
      (target === 'moderator' && this.roleOf(guild, actorId) !== 'owner');
    if (forbidden) throw new StoreError('forbidden', 'You cannot moderate that member.');
    if (!guild.memberIds.includes(targetId)) throw new StoreError('not_found', 'That user is not a member.');
  }

  // --------------------------------------------------------------- guilds

  guildsFor(userId: string): GuildDTO[] {
    return [...this.guilds.values()]
      .filter((g) => g.memberIds.includes(userId))
      .map((g) => this.toGuildDTO(g));
  }

  getGuild(guildId: string): GuildDTO {
    return this.toGuildDTO(this.requireGuild(guildId));
  }

  createGuild(userId: string, name: string): GuildDTO {
    name = this.validateGuildName(name);
    const id = randomUUID();
    const guild: NormalizedGuild = {
      id,
      name,
      ownerId: userId,
      inviteCode: randomBytes(4).toString('hex'),
      memberIds: [userId],
      channels: [{ id: randomUUID(), guildId: id, name: 'general' }],
      description: '',
      icon: null,
      moderatorIds: [],
      bans: [],
      mutes: {},
      bot: { ...DEFAULT_BOT_CONFIG }
    };
    this.guilds.set(id, guild);
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  /** Returns the guild and whether the user was newly added. */
  joinGuild(userId: string, inviteCode: string): { guild: GuildDTO; joined: boolean } {
    const code = inviteCode.trim().toLowerCase();
    const guild = [...this.guilds.values()].find((g) => g.inviteCode === code);
    if (!guild) throw new StoreError('not_found', 'That invite code is not valid.');
    if (guild.bans.some((b) => b.userId === userId)) {
      throw new StoreError('forbidden', 'You are banned from this community.');
    }
    if (guild.memberIds.includes(userId)) return { guild: this.toGuildDTO(guild), joined: false };
    guild.memberIds.push(userId);
    this.scheduleSave();
    return { guild: this.toGuildDTO(guild), joined: true };
  }

  updateGuild(
    userId: string,
    guildId: string,
    update: { name: string; description: string; icon?: string | null }
  ): GuildDTO {
    const guild = this.requireGuild(guildId);
    this.requireOwner(guild, userId);
    const name = this.validateGuildName(update.name);
    const description = update.description.trim();
    if (description.length > LIMITS.guildDescriptionMax) {
      throw new StoreError('bad_request', `Description can be at most ${LIMITS.guildDescriptionMax} characters.`);
    }
    guild.icon = this.swapFile(userId, guild.icon, update.icon, 'icon');
    guild.name = name;
    guild.description = description;
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  /** Deletes the community and everything in it. Returns who to notify. */
  deleteGuild(userId: string, guildId: string): string[] {
    const guild = this.requireGuild(guildId);
    this.requireOwner(guild, userId);
    const members = this.memberIdsOf(guildId);
    for (const channel of guild.channels) this.dropChannelMessages(channel.id);
    this.releaseFile(guild.icon);
    this.guilds.delete(guildId);
    this.scheduleSave();
    return members;
  }

  leaveGuild(userId: string, guildId: string): void {
    const guild = this.requireGuild(guildId);
    if (guild.id === PUBLIC_GUILD_ID) throw new StoreError('forbidden', "You can't leave the Public Square.");
    if (guild.ownerId === userId) {
      throw new StoreError('forbidden', 'Owners cannot leave. Delete the community instead.');
    }
    this.removeMember(guild, userId);
    this.scheduleSave();
  }

  regenerateInvite(userId: string, guildId: string): GuildDTO {
    const guild = this.requireGuild(guildId);
    this.requireModerator(guild, userId);
    if (guild.id === PUBLIC_GUILD_ID) throw new StoreError('forbidden', 'The Public Square invite is fixed.');
    guild.inviteCode = randomBytes(4).toString('hex');
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  createChannel(userId: string, guildId: string, rawName: string): GuildDTO {
    const guild = this.requireGuild(guildId);
    this.requireModerator(guild, userId);
    if (guild.channels.length >= MAX_CHANNELS_PER_GUILD) {
      throw new StoreError('bad_request', 'This community has reached the channel limit.');
    }
    const name = this.validateChannelName(guild, rawName);
    guild.channels.push({ id: randomUUID(), guildId, name });
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  renameChannel(userId: string, channelId: string, rawName: string): GuildDTO {
    const { guild, channel } = this.requireChannel(channelId);
    this.requireModerator(guild, userId);
    channel.name = this.validateChannelName(guild, rawName, channel.id);
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  deleteChannel(userId: string, channelId: string): GuildDTO {
    const { guild } = this.requireChannel(channelId);
    this.requireModerator(guild, userId);
    if (guild.channels.length <= 1) throw new StoreError('bad_request', 'A community needs at least one channel.');
    this.dropChannelMessages(channelId);
    guild.channels = guild.channels.filter((c) => c.id !== channelId);
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  guildIdOfChannel(channelId: string): string {
    return this.requireChannel(channelId).guild.id;
  }

  memberIdsOf(guildId: string): string[] {
    return this.requireGuild(guildId).memberIds.filter((id) => this.users.has(id));
  }

  /** Every user who shares at least one guild with `userId` (including themself). */
  audience(userId: string): Set<string> {
    const ids = new Set<string>([userId]);
    for (const guild of this.guilds.values()) {
      if (guild.memberIds.includes(userId)) guild.memberIds.forEach((id) => ids.add(id));
    }
    return ids;
  }

  // ----------------------------------------------------------- moderation

  setRole(actorId: string, guildId: string, targetId: string, role: 'moderator' | 'member'): GuildDTO {
    const guild = this.requireGuild(guildId);
    this.requireOwner(guild, actorId);
    if (targetId === guild.ownerId || targetId === BOT_ID) throw new StoreError('forbidden', 'That role cannot be changed.');
    if (!guild.memberIds.includes(targetId)) throw new StoreError('not_found', 'That user is not a member.');
    guild.moderatorIds = guild.moderatorIds.filter((id) => id !== targetId);
    if (role === 'moderator') guild.moderatorIds.push(targetId);
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  kick(actorId: string, guildId: string, targetId: string): GuildDTO {
    const guild = this.requireGuild(guildId);
    this.requireCanModerate(guild, actorId, targetId);
    this.removeMember(guild, targetId);
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  ban(actorId: string, guildId: string, targetId: string, reason: string): GuildDTO {
    const guild = this.requireGuild(guildId);
    this.requireCanModerate(guild, actorId, targetId);
    reason = reason.trim().slice(0, LIMITS.banReasonMax);
    this.removeMember(guild, targetId);
    guild.bans = [...guild.bans.filter((b) => b.userId !== targetId), { userId: targetId, reason, at: Date.now() }];
    this.scheduleSave();
    return this.toGuildDTO(guild);
  }

  unban(actorId: string, guildId: string, targetId: string): void {
    const guild = this.requireGuild(guildId);
    this.requireModerator(guild, actorId);
    guild.bans = guild.bans.filter((b) => b.userId !== targetId);
    this.scheduleSave();
  }

  /** Mutes a member for `minutes` (0 lifts the mute). Returns the end time, or null when lifted. */
  mute(actorId: string, guildId: string, targetId: string, minutes: number): number | null {
    const guild = this.requireGuild(guildId);
    this.requireCanModerate(guild, actorId, targetId);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_MUTE_MINUTES) {
      throw new StoreError('bad_request', `Mute duration must be 0-${MAX_MUTE_MINUTES} minutes.`);
    }
    return this.applyMute(guildId, targetId, minutes === 0 ? null : Date.now() + minutes * 60_000);
  }

  /** Mute without a permission check (used by the bot's auto-moderation). */
  applyMute(guildId: string, userId: string, until: number | null): number | null {
    const guild = this.requireGuild(guildId);
    if (until === null) delete guild.mutes[userId];
    else guild.mutes[userId] = until;
    this.scheduleSave();
    return until;
  }

  /** Moderator-only data for the community settings dialog. */
  guildSettings(userId: string, guildId: string): { bot: BotConfig; bans: BanDTO[] } {
    const guild = this.requireGuild(guildId);
    this.requireModerator(guild, userId);
    return {
      bot: { ...guild.bot, blockedWords: [...guild.bot.blockedWords] },
      bans: guild.bans.map((b) => ({ user: this.publicUser(b.userId), reason: b.reason, at: b.at }))
    };
  }

  updateBot(userId: string, guildId: string, bot: BotConfig): void {
    const guild = this.requireGuild(guildId);
    this.requireModerator(guild, userId);
    const words = [
      ...new Set(
        (Array.isArray(bot.blockedWords) ? bot.blockedWords : [])
          .map((w) => String(w).trim().toLowerCase())
          .filter(Boolean)
      )
    ];
    if (words.length > LIMITS.blockedWordsMax || words.some((w) => w.length > LIMITS.blockedWordMax)) {
      throw new StoreError(
        'bad_request',
        `Use at most ${LIMITS.blockedWordsMax} blocked words of ${LIMITS.blockedWordMax} characters each.`
      );
    }
    guild.bot = {
      enabled: bot.enabled === true,
      welcome: bot.welcome === true,
      blockedWords: words,
      blockLinks: bot.blockLinks === true,
      antiSpam: bot.antiSpam === true
    };
    this.scheduleSave();
  }

  botConfig(guildId: string): BotConfig {
    return this.requireGuild(guildId).bot;
  }

  /** Remaining mute time in ms (0 when not muted). */
  muteRemaining(guildId: string, userId: string): number {
    const until = this.requireGuild(guildId).mutes[userId];
    return until ? Math.max(0, until - Date.now()) : 0;
  }

  // ------------------------------------------------------------- messages

  /** Resolves a channel the user is allowed to see, or throws. */
  accessChannel(userId: string, channelId: string): { guildId: string; channel: ChannelDTO } {
    const { guild, channel } = this.requireChannel(channelId);
    if (!guild.memberIds.includes(userId)) {
      throw new StoreError('forbidden', 'You are not a member of this community.');
    }
    return { guildId: guild.id, channel };
  }

  addMessage(userId: string, channelId: string, content: string, attachmentIds: string[] = []): MessageDTO {
    const { guildId } = this.accessChannel(userId, channelId);
    const remaining = this.muteRemaining(guildId, userId);
    if (remaining > 0) {
      throw new StoreError('forbidden', `You are muted for ${Math.ceil(remaining / 60_000)} more minute(s).`);
    }
    content = content.trim();
    const ids = [...new Set(attachmentIds)];
    if (ids.length > LIMITS.attachmentsPerMessage) {
      throw new StoreError('bad_request', `You can attach at most ${LIMITS.attachmentsPerMessage} images.`);
    }
    if ((!content && ids.length === 0) || content.length > LIMITS.messageMax) {
      throw new StoreError('bad_request', `Messages must be 1-${LIMITS.messageMax} characters.`);
    }
    // Validate every attachment before claiming any, so a bad id doesn't consume the others.
    for (const id of ids) this.checkClaimable(userId, id, 'attachment');
    for (const id of ids) this.claimFile(userId, id, 'attachment');
    return this.pushMessage({ channelId, authorId: userId, content, attachments: ids });
  }

  addBotMessage(channelId: string, content: string): MessageDTO {
    this.requireChannel(channelId);
    return this.pushMessage({ channelId, authorId: BOT_ID, content: content.slice(0, LIMITS.messageMax), attachments: [] });
  }

  /** Deletes a message. Allowed for its author and for moderators. */
  deleteMessage(userId: string, channelId: string, messageId: string): void {
    const { guild } = this.requireChannel(channelId);
    if (!guild.memberIds.includes(userId)) throw new StoreError('forbidden', 'You are not a member of this community.');
    const list = this.messages.get(channelId) ?? [];
    const index = list.findIndex((m) => m.id === messageId);
    const message = list[index];
    if (!message) throw new StoreError('not_found', 'Message not found.');
    if (message.authorId !== userId && this.roleOf(guild, userId) === 'member') {
      throw new StoreError('forbidden', 'You can only delete your own messages.');
    }
    this.removeMessages(list, [index]);
    this.scheduleSave();
  }

  /** Deletes the newest `count` messages of a channel; returns their ids. */
  purge(channelId: string, count: number): string[] {
    const list = this.messages.get(channelId) ?? [];
    const n = Math.min(Math.max(0, Math.floor(count)), list.length);
    const indexes = Array.from({ length: n }, (_, i) => list.length - n + i);
    const ids = indexes.map((i) => list[i]!.id);
    this.removeMessages(list, indexes);
    this.scheduleSave();
    return ids;
  }

  history(userId: string, channelId: string): MessageDTO[] {
    this.accessChannel(userId, channelId);
    return (this.messages.get(channelId) ?? []).slice(-HISTORY_PAGE).map((m) => this.toMessageDTO(m));
  }

  // -------------------------------------------------------------- uploads

  registerUpload(
    ownerId: string,
    info: { id: string; kind: UploadKind; mime: string; size: number; name: string; width: number; height: number }
  ): void {
    this.files.set(info.id, { ...info, ownerId, createdAt: Date.now(), attached: false });
    this.scheduleSave();
  }

  getFile(id: string): { mime: string } | undefined {
    const file = this.files.get(id);
    return file && this.media.exists(id) ? { mime: file.mime } : undefined;
  }

  /** Deletes uploads that were never attached to anything. Returns how many were removed. */
  sweepUploads(maxAgeMs: number): number {
    let removed = 0;
    for (const file of [...this.files.values()]) {
      if (!file.attached && Date.now() - file.createdAt > maxAgeMs) {
        this.releaseFile(file.id);
        removed++;
      }
    }
    return removed;
  }

  // ---------------------------------------------------------- persistence

  /** Writes pending changes to disk immediately. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.file) return;
    const snapshot: Snapshot = {
      users: [...this.users.values()],
      guilds: [...this.guilds.values()],
      messages: [...this.messages.values()].flat(),
      sessions: Object.fromEntries(this.sessions),
      files: [...this.files.values()]
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, this.file);
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.flush();
      } catch (err) {
        console.error('[store] failed to save data:', err);
      }
    }, 500);
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    // A corrupt file throws on purpose: crashing is safer than overwriting it with an empty store.
    const snapshot = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
    for (const user of snapshot.users) {
      this.users.set(user.id, user);
      this.userIdsByName.set(user.username.toLowerCase(), user.id);
    }
    for (const guild of snapshot.guilds) this.guilds.set(guild.id, this.normalizeGuild(guild));
    for (const message of snapshot.messages) {
      const list = this.messages.get(message.channelId) ?? [];
      list.push(message);
      this.messages.set(message.channelId, list);
    }
    for (const [token, userId] of Object.entries(snapshot.sessions)) this.sessions.set(token, userId);
    for (const file of snapshot.files ?? []) this.files.set(file.id, file);
  }

  /** Fills in fields that older data files don't have. */
  private normalizeGuild(guild: GuildRecord): NormalizedGuild {
    return {
      ...guild,
      description: guild.description ?? '',
      icon: guild.icon ?? null,
      moderatorIds: guild.moderatorIds ?? [],
      bans: guild.bans ?? [],
      mutes: guild.mutes ?? {},
      bot: { ...DEFAULT_BOT_CONFIG, ...guild.bot }
    };
  }

  private ensurePublicGuild(): void {
    if (this.guilds.has(PUBLIC_GUILD_ID)) return;
    this.guilds.set(
      PUBLIC_GUILD_ID,
      this.normalizeGuild({
        id: PUBLIC_GUILD_ID,
        name: 'Public Square',
        description: 'Everyone is welcome here.',
        ownerId: SYSTEM_USER_ID,
        inviteCode: 'public',
        memberIds: [...this.users.keys()],
        channels: [
          { id: 'public-general', guildId: PUBLIC_GUILD_ID, name: 'general' },
          { id: 'public-random', guildId: PUBLIC_GUILD_ID, name: 'random' }
        ]
      })
    );
    this.scheduleSave();
  }

  // -------------------------------------------------------------- helpers

  private requireUser(id: string): UserRecord {
    const user = this.users.get(id);
    if (!user) throw new StoreError('not_found', 'User not found.');
    return user;
  }

  private requireGuild(guildId: string): NormalizedGuild {
    const guild = this.guilds.get(guildId);
    if (!guild) throw new StoreError('not_found', 'Community not found.');
    return guild;
  }

  private requireChannel(channelId: string): { guild: NormalizedGuild; channel: ChannelDTO } {
    for (const guild of this.guilds.values()) {
      const channel = guild.channels.find((c) => c.id === channelId);
      if (channel) return { guild, channel };
    }
    throw new StoreError('not_found', 'Channel not found.');
  }

  private passwordMatches(user: UserRecord | undefined, password: string): boolean {
    // Always run scrypt so response time doesn't reveal whether the user exists.
    const salt = user?.salt ?? '00'.repeat(16);
    const candidate = Buffer.from(hashPassword(password, salt), 'hex');
    const expected = Buffer.from(user?.hash ?? '00'.repeat(64), 'hex');
    return timingSafeEqual(candidate, expected) && user !== undefined;
  }

  private validatePassword(password: string): void {
    if (password.length < LIMITS.passwordMin || password.length > LIMITS.passwordMax) {
      throw new StoreError('bad_request', `Password must be ${LIMITS.passwordMin}-${LIMITS.passwordMax} characters.`);
    }
  }

  private validateGuildName(name: string): string {
    name = name.trim();
    if (!name || name.length > LIMITS.guildNameMax || CONTROL_CHARS_RE.test(name)) {
      throw new StoreError('bad_request', `Community name must be 1-${LIMITS.guildNameMax} characters.`);
    }
    return name;
  }

  private validateChannelName(guild: GuildRecord, rawName: string, exceptId?: string): string {
    const name = rawName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name || name.length > LIMITS.channelNameMax || !CHANNEL_RE.test(name)) {
      throw new StoreError(
        'bad_request',
        `Channel name must be 1-${LIMITS.channelNameMax} characters: letters, numbers, "-" or "_".`
      );
    }
    if (guild.channels.some((c) => c.name === name && c.id !== exceptId)) {
      throw new StoreError('bad_request', 'A channel with that name already exists.');
    }
    return name;
  }

  private removeMember(guild: GuildRecord, userId: string): void {
    const g = guild as NormalizedGuild;
    g.memberIds = g.memberIds.filter((id) => id !== userId);
    g.moderatorIds = g.moderatorIds.filter((id) => id !== userId);
    delete g.mutes[userId];
  }

  private pushMessage(input: { channelId: string; authorId: string; content: string; attachments: string[] }): MessageDTO {
    const record: MessageRecord = {
      id: randomUUID(),
      channelId: input.channelId,
      authorId: input.authorId,
      content: input.content,
      timestamp: Date.now(),
      attachments: input.attachments
    };
    const list = this.messages.get(input.channelId) ?? [];
    list.push(record);
    if (list.length > MAX_MESSAGES_PER_CHANNEL) {
      this.removeMessages(list, Array.from({ length: list.length - MAX_MESSAGES_PER_CHANNEL }, (_, i) => i));
    }
    this.messages.set(input.channelId, list);
    this.scheduleSave();
    return this.toMessageDTO(record);
  }

  /** Removes messages at the given indexes (in place) and frees their attachments. */
  private removeMessages(list: MessageRecord[], indexes: number[]): void {
    for (const index of [...indexes].sort((a, b) => b - a)) {
      const [removed] = list.splice(index, 1);
      removed?.attachments?.forEach((id) => this.releaseFile(id));
    }
  }

  private dropChannelMessages(channelId: string): void {
    const list = this.messages.get(channelId) ?? [];
    this.removeMessages(list, list.map((_, i) => i));
    this.messages.delete(channelId);
  }

  // ---------------------------------------------------------------- files

  private checkClaimable(userId: string, fileId: string, kind: UploadKind): FileRecord {
    const file = this.files.get(fileId);
    if (!file || file.ownerId !== userId || file.kind !== kind || file.attached) {
      throw new StoreError('bad_request', 'One of the uploaded images is no longer available. Please upload it again.');
    }
    return file;
  }

  private claimFile(userId: string, fileId: string, kind: UploadKind): void {
    this.checkClaimable(userId, fileId, kind).attached = true;
  }

  /**
   * Applies an avatar/icon change: `next` undefined keeps `current`, null clears it, an id replaces it.
   * The previous file is deleted. Returns the new value.
   */
  private swapFile(userId: string, current: string | null, next: string | null | undefined, kind: UploadKind): string | null {
    if (next === undefined || next === current) return current;
    if (next !== null) this.claimFile(userId, next, kind);
    this.releaseFile(current);
    return next;
  }

  private releaseFile(id: string | null | undefined): void {
    if (!id) return;
    this.files.delete(id);
    this.media.remove(id);
  }

  // ------------------------------------------------------------------ DTOs

  private toGuildDTO(guild: NormalizedGuild): GuildDTO {
    const members = guild.memberIds.filter((id) => this.users.has(id)).map((id) => this.publicUser(id));
    const moderatorIds = new Set(guild.moderatorIds);
    if (guild.id === PUBLIC_GUILD_ID) {
      for (const member of members) if (this.isAdmin(member.id)) moderatorIds.add(member.id);
    }
    return {
      id: guild.id,
      name: guild.name,
      description: guild.description,
      icon: guild.icon,
      ownerId: guild.ownerId,
      moderatorIds: [...moderatorIds],
      inviteCode: guild.inviteCode,
      channels: guild.channels,
      members: guild.bot.enabled ? [...members, BOT_USER] : members
    };
  }

  private toMessageDTO(record: MessageRecord): MessageDTO {
    const attachments = (record.attachments ?? [])
      .map((id) => this.files.get(id))
      .filter((file): file is FileRecord => file !== undefined)
      .map(
        (file): AttachmentDTO => ({
          id: file.id,
          url: `/files/${file.id}`,
          mime: file.mime,
          size: file.size,
          name: file.name,
          width: file.width,
          height: file.height
        })
      );
    return {
      id: record.id,
      channelId: record.channelId,
      author: this.publicUser(record.authorId),
      content: record.content,
      timestamp: record.timestamp,
      attachments
    };
  }
}
