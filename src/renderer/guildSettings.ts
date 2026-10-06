import {
  LIMITS,
  PUBLIC_GUILD_ID,
  type BanDTO,
  type BotConfig,
  type GuildDTO,
  type PublicUser,
  type ServerEvent
} from '../shared/protocol';
import { avatar, guildIconContent } from './avatar';
import { el, fill } from './dom';
import type { Gateway } from './gateway';
import { icon, type IconName } from './icons';
import { pickAndUploadSquare } from './media';
import { confirmDialog, openModal, promptDialog, toast } from './modal';
import { openProfileCard, roleBadge } from './profileCard';
import { canModerate, isModerator, roleLabel, roleOf } from './roles';

export interface GuildSettingsContext {
  root: HTMLElement;
  gateway: Gateway;
  token: string;
  me(): PublicUser;
  /** Latest data for a community, or undefined if you are no longer in it. */
  getGuild(guildId: string): GuildDTO | undefined;
  isOnline(userId: string): boolean;
}

export interface GuildSettingsHandle {
  guildId: string;
  handleEvent(event: ServerEvent): void;
  close(): void;
}

type TabId = 'overview' | 'channels' | 'members' | 'bot';

const TAB_META: Record<TabId, { label: string; icon: IconName }> = {
  overview: { label: 'Overview', icon: 'info' },
  channels: { label: 'Channels', icon: 'hash' },
  members: { label: 'Members', icon: 'users' },
  bot: { label: 'Bot', icon: 'bot' }
};

const BOT_COMMANDS = [
  ['/help', 'List the commands'],
  ['/ping', 'Check that the bot is awake'],
  ['/roll 2d6', 'Roll dice'],
  ['/flip', 'Flip a coin'],
  ['/members', 'Show who is online'],
  ['/purge 10', 'Delete the last messages (moderators)'],
  ['/mute @name 10', 'Mute a member for N minutes (moderators)'],
  ['/unmute @name', 'Lift a mute (moderators)'],
  ['/kick @name', 'Remove a member (moderators)']
] as const;

export function openGuildSettings(
  ctx: GuildSettingsContext,
  guildId: string,
  onClose: () => void
): GuildSettingsHandle {
  const { root, gateway } = ctx;
  let guild = ctx.getGuild(guildId);
  if (!guild) throw new Error('Community not found');

  let tab: TabId = 'overview';
  let extra: { bot: BotConfig; bans: BanDTO[] } | null = null;

  const nav = el('nav', { class: 'settings-nav', role: 'tablist', 'aria-label': 'Community settings' });
  const title = el('h2', {});
  const content = el('div', { class: 'settings-content' });

  const close = openModal(
    root,
    'Community settings',
    [
      el(
        'div',
        { class: 'settings' },
        nav,
        el(
          'div',
          { class: 'settings-body' },
          el(
            'header',
            { class: 'settings-header' },
            title,
            el('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: () => close() }, icon('close', 20))
          ),
          content
        )
      )
    ],
    { wide: true, bare: true, onClose }
  );

  const availableTabs = (): TabId[] => {
    const me = ctx.me();
    return guild && isModerator(guild, me.id) ? ['overview', 'channels', 'members', 'bot'] : ['overview'];
  };

  if (isModerator(guild, ctx.me().id)) gateway.send({ type: 'fetch_guild_settings', guildId });

  function render(): void {
    if (!guild) return;
    const tabs = availableTabs();
    if (!tabs.includes(tab)) tab = 'overview';
    nav.replaceChildren(
      ...tabs.map((id) =>
        el(
          'button',
          {
            class: `settings-tab${id === tab ? ' active' : ''}`,
            role: 'tab',
            'aria-selected': id === tab ? 'true' : 'false',
            onclick: () => {
              tab = id;
              render();
            }
          },
          icon(TAB_META[id].icon, 18),
          el('span', {}, TAB_META[id].label)
        )
      )
    );
    title.textContent = `${guild.name} · ${TAB_META[tab].label}`;
    const builders: Record<TabId, () => Node[]> = {
      overview: overviewTab,
      channels: channelsTab,
      members: membersTab,
      bot: botTab
    };
    content.replaceChildren(...builders[tab]());
  }

  // --------------------------------------------------------------- overview

  function overviewTab(): Node[] {
    const g = guild!;
    const me = ctx.me();
    const role = roleOf(g, me.id);
    const isPublic = g.id === PUBLIC_GUILD_ID;
    const nodes: Node[] = [];

    if (role === 'owner') {
      let pendingIcon: { id: string | null; previewUrl: string | null } | undefined;
      let uploading = false;

      const nameInput = el('input', { type: 'text', maxlength: LIMITS.guildNameMax, value: g.name });
      const descriptionInput = el('textarea', {
        class: 'field',
        rows: 3,
        maxlength: LIMITS.guildDescriptionMax,
        placeholder: 'What is this community about?'
      });
      descriptionInput.value = g.description;
      const preview = el('div', { class: 'icon-preview' });
      const iconButtons = el('div', { class: 'form-actions' });
      const save = el('button', { class: 'btn primary', type: 'submit' }, 'Save changes');

      const currentIcon = (): string | null => (pendingIcon === undefined ? g.icon : pendingIcon.previewUrl);
      const refresh = (): void => {
        preview.replaceChildren(guildIconContent({ name: nameInput.value || g.name, icon: currentIcon() }));
        fill(iconButtons,
          el(
            'button',
            { class: 'btn secondary', type: 'button', disabled: uploading, onclick: () => void chooseIcon() },
            icon('upload', 16),
            uploading ? 'Uploading…' : 'Upload icon'
          ),
          currentIcon()
            ? el(
                'button',
                {
                  class: 'btn secondary',
                  type: 'button',
                  onclick: () => {
                    pendingIcon = { id: null, previewUrl: null };
                    refresh();
                  }
                },
                'Remove'
              )
            : null
        );
        const dirty =
          nameInput.value.trim() !== g.name || descriptionInput.value.trim() !== g.description || pendingIcon !== undefined;
        save.disabled = !dirty || uploading || !nameInput.value.trim();
      };
      const chooseIcon = async (): Promise<void> => {
        uploading = true;
        refresh();
        try {
          const uploaded = await pickAndUploadSquare(ctx.token, 'icon');
          if (uploaded) pendingIcon = uploaded;
        } catch (error) {
          toast(root, (error as Error).message);
        }
        uploading = false;
        refresh();
      };
      nameInput.addEventListener('input', refresh);
      descriptionInput.addEventListener('input', refresh);

      nodes.push(
        el(
          'form',
          {
            onsubmit: (event: Event) => {
              event.preventDefault();
              gateway.send({
                type: 'update_guild',
                guildId: g.id,
                name: nameInput.value,
                description: descriptionInput.value,
                icon: pendingIcon?.id
              });
              toast(root, 'Community updated.');
            }
          },
          el('div', { class: 'icon-editor' }, preview, iconButtons),
          el('label', {}, 'Community name'),
          nameInput,
          el('label', {}, 'Description'),
          descriptionInput,
          el('div', { class: 'form-actions' }, save)
        )
      );
      refresh();
    } else {
      nodes.push(
        el(
          'div',
          { class: 'icon-editor' },
          el('div', { class: 'icon-preview' }, guildIconContent(g)),
          el('div', {}, el('strong', { class: 'preview-name' }, g.name), el('p', { class: 'muted' }, g.description || 'No description.'))
        )
      );
    }

    // invite
    const code = el('code', { class: 'invite-code' }, g.inviteCode);
    nodes.push(
      el('h3', {}, 'Invite code'),
      el('p', { class: 'muted' }, 'Share this code so people can join from the + button.'),
      el(
        'div',
        { class: 'mod-row' },
        code,
        el(
          'button',
          {
            class: 'btn secondary',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(g.inviteCode);
                toast(root, 'Invite code copied.');
              } catch {
                toast(root, `Invite code: ${g.inviteCode}`);
              }
            }
          },
          icon('copy', 16),
          'Copy'
        ),
        isModerator(g, me.id) && !isPublic
          ? el(
              'button',
              {
                class: 'btn secondary',
                onclick: async () => {
                  const ok = await confirmDialog(root, {
                    title: 'New invite code',
                    message: 'The current code will stop working. People already in the community stay.',
                    confirmLabel: 'Generate new code'
                  });
                  if (ok) gateway.send({ type: 'regenerate_invite', guildId: g.id });
                }
              },
              'Regenerate'
            )
          : null
      )
    );

    // leave / delete
    if (!isPublic) {
      nodes.push(el('h3', {}, 'Danger zone'));
      if (role === 'owner') {
        nodes.push(
          el('p', { class: 'muted' }, 'Deleting the community removes all its channels, messages and images for everyone.'),
          el(
            'button',
            {
              class: 'btn danger',
              onclick: async () => {
                const typed = await promptDialog(root, {
                  title: 'Delete community',
                  message: `This cannot be undone. Type "${g.name}" to confirm.`,
                  confirmLabel: 'Delete forever',
                  danger: true,
                  input: { placeholder: g.name, maxLength: LIMITS.guildNameMax }
                });
                if (typed === null) return;
                if (typed !== g.name) toast(root, 'The name did not match, so nothing was deleted.');
                else gateway.send({ type: 'delete_guild', guildId: g.id });
              }
            },
            icon('trash', 16),
            'Delete community'
          )
        );
      } else {
        nodes.push(
          el(
            'button',
            {
              class: 'btn danger',
              onclick: async () => {
                const ok = await confirmDialog(root, {
                  title: 'Leave community',
                  message: `Leave ${g.name}? You can rejoin later with an invite code.`,
                  confirmLabel: 'Leave',
                  danger: true
                });
                if (ok) gateway.send({ type: 'leave_guild', guildId: g.id });
              }
            },
            'Leave community'
          )
        );
      }
    }
    return nodes;
  }

  // --------------------------------------------------------------- channels

  function channelsTab(): Node[] {
    const g = guild!;
    const rows = g.channels.map((channel) => {
      const input = el('input', { type: 'text', maxlength: LIMITS.channelNameMax, value: channel.name, 'aria-label': 'Channel name' });
      const rename = el(
        'button',
        {
          class: 'btn secondary',
          disabled: true,
          onclick: () => gateway.send({ type: 'rename_channel', channelId: channel.id, name: input.value })
        },
        'Rename'
      );
      input.addEventListener('input', () => {
        rename.disabled = input.value.trim() === '' || input.value.trim() === channel.name;
      });
      return el(
        'div',
        { class: 'channel-row' },
        el('span', { class: 'hash' }, '#'),
        input,
        rename,
        el(
          'button',
          {
            class: 'icon-btn danger-text',
            title: 'Delete channel',
            'aria-label': `Delete ${channel.name}`,
            disabled: g.channels.length <= 1,
            onclick: async () => {
              const ok = await confirmDialog(root, {
                title: 'Delete channel',
                message: `Delete #${channel.name} and all of its messages?`,
                confirmLabel: 'Delete',
                danger: true
              });
              if (ok) gateway.send({ type: 'delete_channel', channelId: channel.id });
            }
          },
          icon('trash', 18)
        )
      );
    });

    const newName = el('input', { type: 'text', maxlength: LIMITS.channelNameMax, placeholder: 'new-channel' });
    return [
      el('p', { class: 'muted' }, 'Channel names are lowercase; spaces become dashes.'),
      ...rows,
      el(
        'form',
        {
          class: 'channel-row add',
          onsubmit: (event: Event) => {
            event.preventDefault();
            if (!newName.value.trim()) return;
            gateway.send({ type: 'create_channel', guildId: g.id, name: newName.value });
            newName.value = '';
          }
        },
        el('span', { class: 'hash' }, '#'),
        newName,
        el('button', { class: 'btn primary', type: 'submit' }, 'Add channel')
      )
    ];
  }

  // ---------------------------------------------------------------- members

  function membersTab(): Node[] {
    const g = guild!;
    const me = ctx.me();
    const members = g.members.filter((m) => !m.bot).sort((a, b) => a.displayName.localeCompare(b.displayName));

    const rows = members.map((member) => {
      const manageable = canModerate(g, me.id, member);
      return el(
        'div',
        { class: 'member-row' },
        avatar(member, 'sm', ctx.isOnline(member.id)),
        el(
          'div',
          { class: 'member-row-name' },
          el('strong', { class: 'truncate' }, member.displayName, roleBadge(g, member)),
          el('span', { class: 'muted truncate' }, `@${member.username} · ${roleLabel[roleOf(g, member.id)]}`)
        ),
        el(
          'button',
          {
            class: 'btn secondary',
            onclick: () => openProfileCard({ root, gateway, me, guild: g, isOnline: ctx.isOnline }, member)
          },
          manageable ? 'Manage' : 'View'
        )
      );
    });

    const bans = extra
      ? extra.bans.length === 0
        ? [el('p', { class: 'muted' }, 'Nobody is banned.')]
        : extra.bans.map((ban) =>
            el(
              'div',
              { class: 'member-row' },
              avatar(ban.user, 'sm'),
              el(
                'div',
                { class: 'member-row-name' },
                el('strong', { class: 'truncate' }, ban.user.displayName),
                el('span', { class: 'muted truncate' }, ban.reason ? `Reason: ${ban.reason}` : 'No reason given')
              ),
              el(
                'button',
                { class: 'btn secondary', onclick: () => gateway.send({ type: 'unban', guildId: g.id, userId: ban.user.id }) },
                'Unban'
              )
            )
          )
      : [el('p', { class: 'muted' }, 'Loading…')];

    return [el('p', { class: 'muted' }, `${members.length} member(s)`), ...rows, el('h3', {}, 'Banned members'), ...bans];
  }

  // -------------------------------------------------------------------- bot

  function botTab(): Node[] {
    const g = guild!;
    if (!extra) return [el('p', { class: 'muted' }, 'Loading…')];

    const config = extra.bot;
    const toggles = {
      enabled: toggle('Enable the bot', 'Guardian welcomes members, answers commands and moderates chat.', config.enabled),
      welcome: toggle('Welcome new members', 'Post a greeting in the first channel when someone joins.', config.welcome),
      blockLinks: toggle('Block links', 'Remove messages from regular members that contain links.', config.blockLinks),
      antiSpam: toggle('Anti-spam', 'Mute members for a minute if they send messages too quickly.', config.antiSpam)
    };
    const words = el('textarea', {
      class: 'field',
      rows: 5,
      placeholder: 'One word per line',
      'aria-label': 'Blocked words'
    });
    words.value = config.blockedWords.join('\n');

    return [
      el('p', { class: 'muted' }, 'Owners and moderators are never filtered by the bot.'),
      ...Object.values(toggles).map((t) => t.row),
      el('label', {}, `Blocked words (${LIMITS.blockedWordsMax} max)`),
      words,
      el(
        'div',
        { class: 'form-actions' },
        el(
          'button',
          {
            class: 'btn primary',
            onclick: () =>
              gateway.send({
                type: 'update_bot',
                guildId: g.id,
                bot: {
                  enabled: toggles.enabled.input.checked,
                  welcome: toggles.welcome.input.checked,
                  blockLinks: toggles.blockLinks.input.checked,
                  antiSpam: toggles.antiSpam.input.checked,
                  blockedWords: words.value.split('\n').map((w) => w.trim()).filter(Boolean)
                }
              })
          },
          'Save bot settings'
        )
      ),
      el('h3', {}, 'Commands'),
      el(
        'dl',
        { class: 'about' },
        ...BOT_COMMANDS.flatMap(([command, description]) => [el('dt', {}, el('code', {}, command)), el('dd', {}, description)])
      )
    ];
  }

  render();

  return {
    guildId,
    close,
    handleEvent(event) {
      if (event.type === 'guild_update' && event.guild.id === guildId) {
        guild = event.guild;
        // Rebuild freely, except while someone is typing in a form (it would wipe their edits).
        const editing = (tab === 'overview' || tab === 'bot') && content.contains(document.activeElement);
        if (!editing) render();
      } else if (event.type === 'guild_settings' && event.guildId === guildId) {
        extra = { bot: event.bot, bans: event.bans };
        if (tab === 'members' || tab === 'bot') render();
      } else if (event.type === 'guild_remove' && event.guildId === guildId) {
        close();
      }
    }
  };
}

// ------------------------------------------------------------------ widgets

function toggle(label: string, hint: string, checked: boolean): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label });
  input.checked = checked;
  const row = el(
    'div',
    { class: 'setting' },
    el('div', { class: 'setting-text' }, el('strong', {}, label), el('p', { class: 'muted' }, hint)),
    input
  );
  return { row, input };
}
