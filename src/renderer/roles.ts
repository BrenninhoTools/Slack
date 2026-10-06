import type { GuildDTO, PublicUser, Role } from '../shared/protocol';

/** Role of a user in a community, derived from the community data the server sends. */
export function roleOf(guild: GuildDTO, userId: string): Role {
  if (guild.ownerId === userId) return 'owner';
  return guild.moderatorIds.includes(userId) ? 'moderator' : 'member';
}

export const isModerator = (guild: GuildDTO, userId: string): boolean => roleOf(guild, userId) !== 'member';

/**
 * Mirrors the server's rules (the server enforces them regardless): moderators can act on members,
 * only the owner can act on moderators, and nobody can act on the owner, the bot or themself.
 */
export function canModerate(guild: GuildDTO, actorId: string, target: PublicUser): boolean {
  if (target.bot || target.id === actorId) return false;
  const actor = roleOf(guild, actorId);
  const targetRole = roleOf(guild, target.id);
  if (actor === 'member' || targetRole === 'owner') return false;
  return targetRole === 'member' || actor === 'owner';
}

export const roleLabel: Record<Role, string> = { owner: 'Owner', moderator: 'Moderator', member: 'Member' };
