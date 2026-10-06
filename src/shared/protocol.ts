/**
 * Wire protocol shared by the clients and the server.
 * Every WebSocket frame is a single JSON-encoded event with a `type` field.
 * Images are uploaded over HTTP (see UploadResponse) and referenced here by id.
 */

/** Avatar colours a user can pick from. */
export const AVATAR_COLORS = [
  '#5865f2',
  '#8b5cf6',
  '#d946ef',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#0ea5e9',
  '#64748b'
] as const;

export interface PublicUser {
  id: string;
  /** Unique login name. */
  username: string;
  /** Name shown in the UI; defaults to the username. */
  displayName: string;
  bio: string;
  /** One of AVATAR_COLORS; used for the initials avatar when there is no photo. */
  color: string;
  /** Upload id of the profile photo, or null. Resolve with `/files/<id>`. */
  avatar: string | null;
  /** True for the built-in moderation bot. */
  bot?: boolean;
}

export interface ProfileUpdate {
  displayName: string;
  bio: string;
  color: string;
  /** Upload id to set, null to remove the photo, undefined to leave it unchanged. */
  avatar?: string | null;
}

export type Role = 'owner' | 'moderator' | 'member';

/** Id of the community every new user joins automatically. */
export const PUBLIC_GUILD_ID = 'public-square';

export interface ChannelDTO {
  id: string;
  guildId: string;
  name: string;
}

/** A "guild" is a community (what Discord calls a server) that owns channels and members. */
export interface GuildDTO {
  id: string;
  name: string;
  description: string;
  /** Upload id of the community icon, or null. */
  icon: string | null;
  ownerId: string;
  moderatorIds: string[];
  inviteCode: string;
  channels: ChannelDTO[];
  /** Includes the moderation bot while it is enabled for this community. */
  members: PublicUser[];
}

export interface AttachmentDTO {
  id: string;
  /** Server-relative path, e.g. `/files/<id>`. */
  url: string;
  mime: string;
  size: number;
  name: string;
  width: number;
  height: number;
}

export interface MessageDTO {
  id: string;
  channelId: string;
  author: PublicUser;
  content: string;
  timestamp: number;
  attachments: AttachmentDTO[];
}

export interface BotConfig {
  enabled: boolean;
  /** Greet new members in the first channel. */
  welcome: boolean;
  /** Messages containing any of these words are removed (case-insensitive). */
  blockedWords: string[];
  blockLinks: boolean;
  /** Mute members who send too many messages too quickly. */
  antiSpam: boolean;
}

export interface BanDTO {
  user: PublicUser;
  reason: string;
  at: number;
}

export interface UploadResponse {
  id: string;
  url: string;
  mime: string;
  size: number;
  width: number;
  height: number;
}

export type UploadKind = 'avatar' | 'icon' | 'attachment';

export const UPLOAD_MAX_BYTES: Record<UploadKind, number> = {
  avatar: 2 * 1024 * 1024,
  icon: 2 * 1024 * 1024,
  attachment: 8 * 1024 * 1024
};

export const LIMITS = {
  usernameMin: 2,
  usernameMax: 32,
  passwordMin: 8,
  passwordMax: 128,
  displayNameMax: 32,
  bioMax: 190,
  guildNameMax: 50,
  guildDescriptionMax: 200,
  channelNameMax: 32,
  messageMax: 2000,
  attachmentsPerMessage: 4,
  blockedWordsMax: 50,
  blockedWordMax: 32,
  banReasonMax: 120
} as const;

export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: true,
  welcome: true,
  blockedWords: [],
  blockLinks: false,
  antiSpam: true
};

export type ClientEvent =
  | { type: 'register'; username: string; password: string }
  | { type: 'login'; username: string; password: string }
  | { type: 'resume'; token: string }
  | { type: 'logout' }
  | ({ type: 'update_profile' } & ProfileUpdate)
  | { type: 'change_password'; currentPassword: string; newPassword: string }
  // communities
  | { type: 'create_guild'; name: string }
  | { type: 'join_guild'; inviteCode: string }
  | { type: 'leave_guild'; guildId: string }
  | { type: 'delete_guild'; guildId: string }
  | { type: 'update_guild'; guildId: string; name: string; description: string; icon?: string | null }
  | { type: 'regenerate_invite'; guildId: string }
  | { type: 'create_channel'; guildId: string; name: string }
  | { type: 'rename_channel'; channelId: string; name: string }
  | { type: 'delete_channel'; channelId: string }
  // messages
  | { type: 'fetch_history'; channelId: string }
  | { type: 'send_message'; channelId: string; content: string; attachmentIds?: string[] }
  | { type: 'delete_message'; channelId: string; messageId: string }
  | { type: 'typing'; channelId: string }
  // moderation
  | { type: 'set_role'; guildId: string; userId: string; role: 'moderator' | 'member' }
  | { type: 'kick'; guildId: string; userId: string }
  | { type: 'ban'; guildId: string; userId: string; reason: string }
  | { type: 'unban'; guildId: string; userId: string }
  /** `minutes` of 0 lifts a mute. */
  | { type: 'mute'; guildId: string; userId: string; minutes: number }
  | { type: 'fetch_guild_settings'; guildId: string }
  | { type: 'update_bot'; guildId: string; bot: BotConfig };

export type ServerEvent =
  | { type: 'auth_ok'; token: string; user: PublicUser }
  | { type: 'ready'; guilds: GuildDTO[]; online: string[] }
  | { type: 'guild_create'; guild: GuildDTO; online: string[] }
  | { type: 'guild_update'; guild: GuildDTO }
  | { type: 'guild_remove'; guildId: string; reason: 'left' | 'kicked' | 'banned' | 'deleted' }
  /** Moderator-only data for the community settings dialog. */
  | { type: 'guild_settings'; guildId: string; bot: BotConfig; bans: BanDTO[] }
  | { type: 'history'; channelId: string; messages: MessageDTO[] }
  | { type: 'message_create'; message: MessageDTO }
  | { type: 'message_delete'; channelId: string; messageId: string }
  | { type: 'presence_update'; userId: string; online: boolean }
  | { type: 'user_update'; user: PublicUser }
  | { type: 'password_changed' }
  /** Short confirmation of an action the user just took (e.g. a moderation action). */
  | { type: 'notice'; message: string }
  | { type: 'typing'; channelId: string; user: PublicUser }
  | { type: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'bad_request'
  | 'invalid_credentials'
  | 'invalid_token'
  | 'username_taken'
  | 'not_authenticated'
  | 'already_authenticated'
  | 'forbidden'
  | 'not_found'
  | 'blocked'
  | 'rate_limited';
