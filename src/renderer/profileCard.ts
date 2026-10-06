import type { GuildDTO, PublicUser } from '../shared/protocol';
import { LIMITS } from '../shared/protocol';
import { avatar } from './avatar';
import { el } from './dom';
import type { Gateway } from './gateway';
import { icon } from './icons';
import { confirmDialog, openModal, promptDialog } from './modal';
import { canModerate, roleOf } from './roles';

export interface ProfileCardContext {
  root: HTMLElement;
  gateway: Gateway;
  me: PublicUser;
  /** The community being viewed; enables the role badge and moderation actions. */
  guild?: GuildDTO;
  isOnline(userId: string): boolean;
}

const MUTE_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 5, label: '5 minutes' },
  { minutes: 10, label: '10 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 1440, label: '1 day' },
  { minutes: 10080, label: '1 week' }
];

/** Role badge shown next to names: crown for owner, shield for moderators, tag for the bot. */
export function roleBadge(guild: GuildDTO | undefined, user: PublicUser): HTMLElement | null {
  if (user.bot) return el('span', { class: 'badge bot', title: 'Bot' }, icon('bot', 12), 'BOT');
  const role = guild ? roleOf(guild, user.id) : 'member';
  if (role === 'owner') return el('span', { class: 'badge owner', title: 'Owner' }, icon('crown', 12));
  if (role === 'moderator') return el('span', { class: 'badge mod', title: 'Moderator' }, icon('shield', 12));
  return null;
}

/** Dialog showing someone's profile, with moderation actions when you are allowed to use them. */
export function openProfileCard(ctx: ProfileCardContext, user: PublicUser): void {
  const { root, gateway, me, guild } = ctx;
  const online = user.bot === true || ctx.isOnline(user.id);

  const sections: Node[] = [
    avatar(user, 'xl', online),
    el(
      'div',
      { class: 'profile-names' },
      el('strong', { class: 'preview-name' }, user.displayName, roleBadge(guild, user)),
      el('div', { class: 'muted' }, user.bot ? 'Built-in moderation bot' : `@${user.username}`)
    ),
    el('div', { class: 'muted status' }, online ? 'Online' : 'Offline'),
    user.bio
      ? el('p', { class: 'bio' }, user.bio)
      : el('p', { class: 'muted' }, user.bot ? 'Type /help in any channel to see what I can do.' : 'This user has not written anything yet.')
  ];

  const card = el('div', { class: 'profile-card' }, ...sections);
  const close = openModal(root, user.displayName, [card]);

  if (!guild || !canModerate(guild, me.id, user)) return;
  const guildId = guild.id;

  // ---- moderation
  const duration = el(
    'select',
    { class: 'field', 'aria-label': 'Mute duration' },
    ...MUTE_OPTIONS.map((option) => el('option', { value: option.minutes }, option.label))
  );
  duration.value = '10';

  const actions = el(
    'div',
    { class: 'mod-actions' },
    el('h3', {}, 'Moderation'),
    el(
      'div',
      { class: 'mod-row' },
      duration,
      el(
        'button',
        {
          class: 'btn secondary',
          onclick: () => gateway.send({ type: 'mute', guildId, userId: user.id, minutes: Number(duration.value) })
        },
        'Mute'
      ),
      el(
        'button',
        { class: 'btn secondary', onclick: () => gateway.send({ type: 'mute', guildId, userId: user.id, minutes: 0 }) },
        'Unmute'
      )
    )
  );

  if (roleOf(guild, me.id) === 'owner') {
    const isMod = roleOf(guild, user.id) === 'moderator';
    actions.append(
      el(
        'button',
        {
          class: 'btn secondary wide',
          onclick: () => {
            gateway.send({ type: 'set_role', guildId, userId: user.id, role: isMod ? 'member' : 'moderator' });
            close();
          }
        },
        icon('shield', 16),
        isMod ? 'Remove moderator role' : 'Make moderator'
      )
    );
  }

  actions.append(
    el(
      'div',
      { class: 'mod-row' },
      el(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            const ok = await confirmDialog(root, {
              title: 'Remove member',
              message: `Remove ${user.displayName} from ${guild.name}? They can rejoin with an invite.`,
              confirmLabel: 'Remove',
              danger: true
            });
            if (!ok) return;
            gateway.send({ type: 'kick', guildId, userId: user.id });
            close();
          }
        },
        'Kick'
      ),
      el(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            const reason = await promptDialog(root, {
              title: 'Ban member',
              message: `${user.displayName} will be removed and cannot rejoin until unbanned.`,
              confirmLabel: 'Ban',
              danger: true,
              input: { placeholder: 'Reason (optional)', maxLength: LIMITS.banReasonMax }
            });
            if (reason === null) return;
            gateway.send({ type: 'ban', guildId, userId: user.id, reason });
            close();
          }
        },
        'Ban'
      )
    )
  );
  card.append(actions);
}
