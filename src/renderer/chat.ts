import {
  LIMITS,
  UPLOAD_MAX_BYTES,
  type AttachmentDTO,
  type GuildDTO,
  type MessageDTO,
  type PublicUser,
  type ServerEvent
} from '../shared/protocol';
import { avatar, guildIconContent } from './avatar';
import { clear, el } from './dom';
import type { Gateway, GatewayStatus } from './gateway';
import { icon } from './icons';
import { IMAGE_ACCEPT, isSupportedImage, prepareImage } from './images';
import { mediaUrl, uploadImage } from './media';
import { closeTopModal, confirmDialog, openLightbox, openModal, toast as showToast } from './modal';
import { isMobile } from './platform';
import { openProfileCard, roleBadge } from './profileCard';
import { isModerator } from './roles';
import { getSettings, notify, onSettingsChange } from './settings';
import { openGuildSettings, type GuildSettingsHandle } from './guildSettings';
import { openSettings, type SettingsHandle } from './settingsView';
import type { View } from './view';

export interface ChatDeps {
  user: PublicUser;
  gateway: Gateway;
  serverUrl: string;
  /** Session token, needed to authorise image uploads. */
  token: string;
  onLogout(): void;
}

const COMPACT_WINDOW_MS = 5 * 60_000;
const TYPING_TTL_MS = 5000;
const TYPING_SEND_INTERVAL_MS = 3000;
const ATTACHMENT_MAX_SIDE = 2048;

/** An image waiting in the composer: still uploading, or uploaded and ready to send. */
interface PendingImage {
  name: string;
  previewUrl: string | null;
  state: 'uploading' | 'ready';
  id: string | null;
}

export function createChatView(
  root: HTMLElement,
  { user: initialUser, gateway, serverUrl, token, onLogout }: ChatDeps
): View {
  // ------------------------------------------------------------------ state
  let me = initialUser;
  let guilds: GuildDTO[] = [];
  let activeGuildId: string | null = null;
  let activeChannelId: string | null = null;
  const lastChannelByGuild = new Map<string, string>();
  const messages = new Map<string, MessageDTO[]>();
  const loaded = new Set<string>();
  const unread = new Set<string>();
  const online = new Set<string>([me.id]);
  const typing = new Map<string, Map<string, { name: string; timer: number }>>();
  const pending: PendingImage[] = [];
  let lastTypingSent = 0;
  let settingsHandle: SettingsHandle | null = null;
  let guildSettingsHandle: GuildSettingsHandle | null = null;
  let lastClock = getSettings().clock;

  const toast = (text: string) => showToast(root, text);
  const isOnline = (u: PublicUser) => u.bot === true || online.has(u.id);

  // -------------------------------------------------------------------- DOM
  const guildRail = el('nav', { class: 'guild-rail', 'aria-label': 'Communities' });
  const sidebarHeader = el('div', { class: 'sidebar-header' });
  const channelList = el('div', { class: 'channel-list' });
  const userBar = el('div', { class: 'user-bar' });
  const chatHeader = el('header', { class: 'chat-header' });
  const messageList = el('div', { class: 'message-list' });
  const typingBar = el('div', { class: 'typing-bar' });
  const pendingStrip = el('div', { class: 'pending-strip', 'aria-label': 'Images to send' });
  pendingStrip.hidden = true;

  const fileInput = el('input', {
    type: 'file',
    accept: IMAGE_ACCEPT,
    multiple: true,
    hidden: true,
    onchange: () => {
      void addFiles([...(fileInput.files ?? [])]);
      fileInput.value = '';
    }
  });
  const attachButton = el(
    'button',
    {
      class: 'icon-btn attach-btn',
      type: 'button',
      title: 'Attach images',
      'aria-label': 'Attach images',
      onclick: () => fileInput.click()
    },
    icon('paperclip', 22)
  );
  const input = el('textarea', {
    class: 'composer-input',
    rows: 1,
    maxlength: LIMITS.messageMax,
    placeholder: 'Message…',
    onkeydown: (event: KeyboardEvent) => {
      // On phones Enter inserts a new line; the send button sends.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isMobile()) {
        event.preventDefault();
        sendMessage();
      }
    },
    oninput: () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      announceTyping();
    },
    onpaste: (event: ClipboardEvent) => {
      const images = [...(event.clipboardData?.files ?? [])].filter(isSupportedImage);
      if (images.length === 0) return;
      event.preventDefault();
      void addFiles(images);
    }
  });
  const sendButton = el(
    'button',
    { class: 'send-btn', type: 'button', title: 'Send', 'aria-label': 'Send message', onclick: sendMessage },
    icon('send', 20)
  );
  const memberList = el('aside', { class: 'member-list', 'aria-label': 'Members' });
  const banner = el('div', { class: 'banner', role: 'status' }, 'Connection lost. Reconnecting…');
  banner.hidden = true;
  const backdrop = el('div', { class: 'drawer-backdrop', onclick: () => closeDrawers() });
  const chatEl = el(
    'main',
    { class: 'chat' },
    chatHeader,
    messageList,
    typingBar,
    el('div', { class: 'composer' }, pendingStrip, el('div', { class: 'composer-row' }, attachButton, input, sendButton), fileInput)
  );
  const appEl = el(
    'div',
    { class: 'app' },
    el('div', { class: 'nav-drawer' }, guildRail, el('aside', { class: 'sidebar' }, sidebarHeader, channelList, userBar)),
    chatEl,
    memberList,
    backdrop
  );

  // Drag and drop images anywhere on the chat.
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true;
  chatEl.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    chatEl.classList.add('dropping');
  });
  chatEl.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null || !chatEl.contains(event.relatedTarget as Node)) chatEl.classList.remove('dropping');
  });
  chatEl.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    chatEl.classList.remove('dropping');
    void addFiles([...(event.dataTransfer?.files ?? [])]);
  });

  clear(root);
  root.append(banner, appEl);

  // ---------------------------------------------------------------- drawers
  function closeDrawers(): boolean {
    const wasOpen = appEl.classList.contains('nav-open') || appEl.classList.contains('members-open');
    appEl.classList.remove('nav-open', 'members-open');
    return wasOpen;
  }

  function toggleDrawer(which: 'nav-open' | 'members-open'): void {
    const open = !appEl.classList.contains(which);
    closeDrawers();
    if (open) appEl.classList.add(which);
  }

  // -------------------------------------------------------------- selectors
  const activeGuild = () => guilds.find((g) => g.id === activeGuildId);
  const activeChannel = () => activeGuild()?.channels.find((c) => c.id === activeChannelId);
  const findChannel = (channelId: string) =>
    guilds.flatMap((g) => g.channels.map((c) => ({ guild: g, channel: c }))).find((x) => x.channel.id === channelId);

  function selectGuild(guildId: string): void {
    const guild = guilds.find((g) => g.id === guildId);
    if (!guild) return;
    activeGuildId = guild.id;
    const remembered = lastChannelByGuild.get(guild.id);
    selectChannel(guild.channels.find((c) => c.id === remembered)?.id ?? guild.channels[0]?.id ?? null);
  }

  function selectChannel(channelId: string | null): void {
    activeChannelId = channelId;
    if (channelId && activeGuildId) {
      lastChannelByGuild.set(activeGuildId, channelId);
      unread.delete(channelId);
      if (!loaded.has(channelId)) gateway.send({ type: 'fetch_history', channelId });
    }
    closeDrawers();
    renderAll();
    if (channelId && !isMobile()) input.focus();
  }

  // ---------------------------------------------------------------- actions
  function sendMessage(): void {
    const content = input.value.trim();
    if (!activeChannelId) return;
    if (pending.some((p) => p.state === 'uploading')) {
      toast('Please wait for your images to finish uploading.');
      return;
    }
    const ready = pending.filter((p) => p.state === 'ready' && p.id !== null);
    if (!content && ready.length === 0) return;

    gateway.send({
      type: 'send_message',
      channelId: activeChannelId,
      content,
      attachmentIds: ready.map((p) => p.id as string)
    });
    input.value = '';
    input.style.height = 'auto';
    lastTypingSent = 0;
    clearPending();
  }

  function announceTyping(): void {
    const now = Date.now();
    if (!activeChannelId || !input.value || now - lastTypingSent < TYPING_SEND_INTERVAL_MS) return;
    lastTypingSent = now;
    gateway.send({ type: 'typing', channelId: activeChannelId });
  }

  async function copyInvite(guild: GuildDTO): Promise<void> {
    try {
      await navigator.clipboard.writeText(guild.inviteCode);
      toast('Invite code copied to the clipboard.');
    } catch {
      toast(`Invite code: ${guild.inviteCode}`);
    }
  }

  function openSettingsDialog(): void {
    closeDrawers();
    settingsHandle = openSettings(
      { root, gateway, token, getUser: () => me, serverUrl, onLogout },
      () => {
        settingsHandle = null;
      }
    );
  }

  function openGuildSettingsDialog(guild: GuildDTO): void {
    closeDrawers();
    guildSettingsHandle = openGuildSettings(
      {
        root,
        gateway,
        token,
        me: () => me,
        getGuild: (id) => guilds.find((g) => g.id === id),
        isOnline: (id) => online.has(id)
      },
      guild.id,
      () => {
        guildSettingsHandle = null;
      }
    );
  }

  const showProfile = (target: PublicUser) =>
    openProfileCard({ root, gateway, me, guild: activeGuild(), isOnline: (id) => online.has(id) }, target);

  async function deleteMessage(message: MessageDTO): Promise<void> {
    const ok = await confirmDialog(root, {
      title: 'Delete message',
      message: 'This message will be removed for everyone. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    });
    if (ok) gateway.send({ type: 'delete_message', channelId: message.channelId, messageId: message.id });
  }

  // ---------------------------------------------------------- attachments
  async function addFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (!isSupportedImage(file)) {
        toast('Only PNG, JPEG, GIF and WebP images can be attached.');
        continue;
      }
      if (pending.length >= LIMITS.attachmentsPerMessage) {
        toast(`You can attach up to ${LIMITS.attachmentsPerMessage} images per message.`);
        break;
      }
      const item: PendingImage = { name: file.name, previewUrl: null, state: 'uploading', id: null };
      pending.push(item);
      renderPending();
      void uploadPending(item, file);
    }
  }

  async function uploadPending(item: PendingImage, file: File): Promise<void> {
    try {
      const prepared = await prepareImage(file, { maxSide: ATTACHMENT_MAX_SIDE, maxBytes: UPLOAD_MAX_BYTES.attachment });
      item.previewUrl = prepared.previewUrl;
      renderPending();
      item.id = (await uploadImage(token, 'attachment', prepared)).id;
      item.state = 'ready';
    } catch (error) {
      toast((error as Error).message);
      removePending(item);
      return;
    }
    renderPending();
  }

  function removePending(item: PendingImage): void {
    const index = pending.indexOf(item);
    if (index !== -1) pending.splice(index, 1);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    renderPending();
  }

  function clearPending(): void {
    pending.splice(0).forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
    renderPending();
  }

  function renderPending(): void {
    pendingStrip.hidden = pending.length === 0;
    pendingStrip.replaceChildren(
      ...pending.map((item) =>
        el(
          'div',
          { class: `pending-item ${item.state}` },
          item.previewUrl ? el('img', { src: item.previewUrl, alt: item.name }) : null,
          item.state === 'uploading' ? el('span', { class: 'pending-spinner', role: 'progressbar', 'aria-label': 'Uploading' }) : null,
          el(
            'button',
            { class: 'pending-remove', type: 'button', 'aria-label': `Remove ${item.name}`, onclick: () => removePending(item) },
            icon('close', 14)
          )
        )
      )
    );
  }

  // -------------------------------------------------------------- rendering
  function renderAll(): void {
    renderGuilds();
    renderSidebar();
    renderHeader();
    renderMessages();
    renderMembers();
    renderTyping();
    renderComposer();
  }

  function renderComposer(): void {
    const channel = activeChannel();
    input.disabled = !channel;
    attachButton.disabled = !channel;
    input.placeholder = channel ? `Message #${channel.name}` : 'Select a channel';
  }

  function renderGuilds(): void {
    clear(guildRail);
    for (const guild of guilds) {
      const hasUnread = guild.channels.some((c) => unread.has(c.id));
      const classes = ['guild-btn'];
      if (guild.id === activeGuildId) classes.push('active');
      if (hasUnread) classes.push('unread');
      if (guild.icon) classes.push('has-icon');
      guildRail.append(
        el(
          'button',
          { class: classes.join(' '), title: guild.name, 'aria-label': guild.name, onclick: () => selectGuild(guild.id) },
          guildIconContent(guild)
        )
      );
    }
    guildRail.append(
      el('div', { class: 'rail-divider' }),
      el(
        'button',
        {
          class: 'guild-btn add',
          title: 'Create or join a community',
          'aria-label': 'Add community',
          onclick: openGuildModal
        },
        icon('plus', 24)
      )
    );
  }

  function renderSidebar(): void {
    const guild = activeGuild();
    clear(sidebarHeader);
    clear(channelList);
    renderUserBar();
    if (!guild) {
      sidebarHeader.append(el('strong', {}, 'No community'));
      return;
    }
    sidebarHeader.append(
      el('strong', { class: 'truncate' }, guild.name),
      el(
        'span',
        { class: 'header-actions' },
        el(
          'button',
          { class: 'icon-btn', title: 'Copy invite code', 'aria-label': 'Copy invite code', onclick: () => void copyInvite(guild) },
          icon('copy')
        ),
        el(
          'button',
          {
            class: 'icon-btn',
            title: 'Community settings',
            'aria-label': 'Community settings',
            onclick: () => openGuildSettingsDialog(guild)
          },
          icon('settings')
        )
      )
    );

    channelList.append(
      el(
        'div',
        { class: 'section-title' },
        el('span', {}, 'Text channels'),
        isModerator(guild, me.id) &&
          el(
            'button',
            { class: 'icon-btn', title: 'Create channel', 'aria-label': 'Create channel', onclick: () => openChannelModal(guild) },
            icon('plus', 16)
          )
      )
    );
    for (const channel of guild.channels) {
      const classes = ['channel'];
      if (channel.id === activeChannelId) classes.push('active');
      if (unread.has(channel.id)) classes.push('unread');
      channelList.append(
        el(
          'button',
          { class: classes.join(' '), onclick: () => selectChannel(channel.id) },
          el('span', { class: 'hash' }, '#'),
          el('span', { class: 'truncate' }, channel.name)
        )
      );
    }
  }

  function renderUserBar(): void {
    userBar.replaceChildren(
      el(
        'button',
        { class: 'user-bar-profile', title: 'Open settings', onclick: openSettingsDialog },
        avatar(me, 'sm', true),
        el(
          'div',
          { class: 'user-bar-name' },
          el('strong', { class: 'truncate' }, me.displayName),
          el('span', { class: 'muted truncate' }, `@${me.username}`)
        )
      ),
      el(
        'button',
        { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: openSettingsDialog },
        icon('settings', 20)
      )
    );
  }

  function renderHeader(): void {
    clear(chatHeader);
    const channel = activeChannel();
    chatHeader.append(
      el(
        'button',
        { class: 'icon-btn drawer-toggle', title: 'Channels', 'aria-label': 'Show channels', onclick: () => toggleDrawer('nav-open') },
        icon('menu', 22)
      ),
      channel
        ? el('span', { class: 'chat-title truncate' }, el('span', { class: 'hash' }, '# '), el('strong', {}, channel.name))
        : el('strong', { class: 'chat-title' }, 'Welcome'),
      el(
        'button',
        { class: 'icon-btn members-toggle', title: 'Members', 'aria-label': 'Show members', onclick: () => toggleDrawer('members-open') },
        icon('users', 22)
      )
    );
  }

  const messageContext = () => {
    const guild = activeGuild();
    return {
      onProfile: showProfile,
      canDelete: (message: MessageDTO) =>
        message.author.id === me.id || (guild !== undefined && isModerator(guild, me.id)),
      onDelete: (message: MessageDTO) => void deleteMessage(message),
      onImage: (attachment: AttachmentDTO) => openLightbox(root, mediaUrl(attachment.url), attachment.name)
    };
  };

  function renderMessages(keepScroll = false): void {
    const previousScroll = messageList.scrollTop;
    clear(messageList);
    const channel = activeChannel();
    if (!channel) {
      messageList.append(el('div', { class: 'empty' }, 'Pick a channel to start chatting.'));
      return;
    }
    if (!loaded.has(channel.id)) {
      messageList.append(el('div', { class: 'empty' }, 'Loading messages…'));
      return;
    }
    const list = messages.get(channel.id) ?? [];
    if (list.length === 0) {
      messageList.append(el('div', { class: 'empty' }, `This is the beginning of #${channel.name}. Say hello!`));
    }
    const context = messageContext();
    list.forEach((message, i) => messageList.append(messageNode(message, list[i - 1], context)));
    messageList.scrollTop = keepScroll ? previousScroll : messageList.scrollHeight;
  }

  function appendMessage(message: MessageDTO): void {
    const list = messages.get(message.channelId) ?? [];
    messages.set(message.channelId, list);
    if (list.some((m) => m.id === message.id)) return;
    const previous = list[list.length - 1];
    list.push(message);

    if (message.channelId !== activeChannelId) return;
    const stickToBottom =
      messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80 ||
      message.author.id === me.id;
    if (list.length === 1) clear(messageList);
    messageList.append(messageNode(message, previous, messageContext()));
    if (stickToBottom) messageList.scrollTop = messageList.scrollHeight;
  }

  function renderMembers(): void {
    clear(memberList);
    const guild = activeGuild();
    if (!guild) return;
    const byName = (a: PublicUser, b: PublicUser) => a.displayName.localeCompare(b.displayName);
    const onlineMembers = guild.members.filter(isOnline).sort(byName);
    const offlineMembers = guild.members.filter((m) => !isOnline(m)).sort(byName);

    const section = (title: string, members: PublicUser[], offline: boolean) => {
      if (members.length === 0) return;
      memberList.append(el('div', { class: 'section-title' }, `${title} — ${members.length}`));
      for (const member of members) {
        memberList.append(
          el(
            'button',
            { class: `member${offline ? ' offline' : ''}`, onclick: () => showProfile(member) },
            avatar(member, 'sm', isOnline(member)),
            el('span', { class: 'truncate' }, member.displayName),
            roleBadge(guild, member)
          )
        );
      }
    };
    section('Online', onlineMembers, false);
    section('Offline', offlineMembers, true);
  }

  function renderTyping(): void {
    const names = [...(typing.get(activeChannelId ?? '')?.values() ?? [])].map((t) => t.name);
    typingBar.textContent =
      names.length === 0
        ? ''
        : names.length === 1
          ? `${names[0]} is typing…`
          : names.length === 2
            ? `${names[0]} and ${names[1]} are typing…`
            : 'Several people are typing…';
  }

  function clearTyping(channelId: string, userId: string): void {
    const entry = typing.get(channelId)?.get(userId);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    typing.get(channelId)?.delete(userId);
  }

  // ----------------------------------------------------------------- modals
  function openGuildModal(): void {
    const nameInput = el('input', { type: 'text', maxlength: LIMITS.guildNameMax, placeholder: 'My awesome community' });
    const codeInput = el('input', { type: 'text', maxlength: 32, placeholder: 'Invite code', spellcheck: false });
    openModal(root, 'Add a community', [
      el(
        'form',
        {
          onsubmit: (event: Event) => {
            event.preventDefault();
            if (nameInput.value.trim()) gateway.send({ type: 'create_guild', name: nameInput.value });
          }
        },
        el('label', {}, 'Create your own'),
        nameInput,
        el('button', { class: 'btn primary', type: 'submit' }, 'Create')
      ),
      el('div', { class: 'modal-divider' }, 'or'),
      el(
        'form',
        {
          onsubmit: (event: Event) => {
            event.preventDefault();
            if (codeInput.value.trim()) gateway.send({ type: 'join_guild', inviteCode: codeInput.value });
          }
        },
        el('label', {}, 'Join with an invite code'),
        codeInput,
        el('button', { class: 'btn secondary', type: 'submit' }, 'Join')
      )
    ]);
  }

  function openChannelModal(guild: GuildDTO): void {
    const nameInput = el('input', { type: 'text', maxlength: LIMITS.channelNameMax, placeholder: 'new-channel' });
    const close = openModal(root, 'Create a channel', [
      el(
        'form',
        {
          onsubmit: (event: Event) => {
            event.preventDefault();
            if (!nameInput.value.trim()) return;
            gateway.send({ type: 'create_channel', guildId: guild.id, name: nameInput.value });
            close();
          }
        },
        el('label', {}, 'Channel name'),
        nameInput,
        el('button', { class: 'btn primary', type: 'submit' }, 'Create')
      )
    ]);
  }

  // ----------------------------------------------------------------- events
  function handleEvent(event: ServerEvent): void {
    settingsHandle?.handleEvent(event);
    guildSettingsHandle?.handleEvent(event);

    switch (event.type) {
      case 'ready': {
        guilds = event.guilds;
        online.clear();
        online.add(me.id);
        event.online.forEach((id) => online.add(id));
        loaded.clear(); // history is re-fetched so a reconnect never leaves gaps
        const keep = guilds.some((g) => g.id === activeGuildId) ? activeGuildId : (guilds[0]?.id ?? null);
        const channels = guilds.find((g) => g.id === keep)?.channels ?? [];
        activeGuildId = keep;
        const own = guilds.flatMap((g) => g.members).find((m) => m.id === me.id);
        if (own) me = own;
        selectChannel(channels.find((c) => c.id === activeChannelId)?.id ?? channels[0]?.id ?? null);
        break;
      }
      case 'guild_create': {
        guilds = [...guilds.filter((g) => g.id !== event.guild.id), event.guild];
        event.online.forEach((id) => online.add(id));
        closeTopModal();
        selectGuild(event.guild.id);
        break;
      }
      case 'guild_update': {
        guilds = guilds.map((g) => (g.id === event.guild.id ? event.guild : g));
        if (event.guild.id === activeGuildId && !activeChannel()) {
          // The channel we were looking at was deleted.
          selectChannel(event.guild.channels[0]?.id ?? null);
          break;
        }
        renderGuilds();
        renderSidebar();
        renderHeader();
        renderMembers();
        renderComposer();
        break;
      }
      case 'guild_remove': {
        const removed = guilds.find((g) => g.id === event.guildId);
        guilds = guilds.filter((g) => g.id !== event.guildId);
        if (removed) {
          const text = {
            kicked: `You were removed from ${removed.name}.`,
            banned: `You were banned from ${removed.name}.`,
            deleted: `${removed.name} was deleted by its owner.`,
            left: ''
          }[event.reason];
          if (text) toast(text);
        }
        if (event.guildId === activeGuildId) {
          activeGuildId = null;
          activeChannelId = null;
          const next = guilds[0];
          if (next) selectGuild(next.id);
          else renderAll();
        } else {
          renderGuilds();
        }
        break;
      }
      case 'history': {
        messages.set(event.channelId, event.messages);
        loaded.add(event.channelId);
        if (event.channelId === activeChannelId) renderMessages();
        break;
      }
      case 'message_create': {
        const { message } = event;
        clearTyping(message.channelId, message.author.id);
        const isOwn = message.author.id === me.id;
        if (!loaded.has(message.channelId)) {
          // History will arrive with this message included; only flag it.
          if (message.channelId !== activeChannelId) unread.add(message.channelId);
        } else {
          appendMessage(message);
          if (message.channelId !== activeChannelId && !isOwn) unread.add(message.channelId);
        }
        if (!isOwn) {
          const where = findChannel(message.channelId);
          notify(
            `${message.author.displayName}${where ? ` · #${where.channel.name} (${where.guild.name})` : ''}`,
            message.content ? message.content.slice(0, 140) : 'Sent an image'
          );
        }
        renderGuilds();
        renderSidebar();
        renderTyping();
        break;
      }
      case 'message_delete': {
        const list = messages.get(event.channelId);
        if (list) {
          messages.set(event.channelId, list.filter((m) => m.id !== event.messageId));
          if (event.channelId === activeChannelId) renderMessages(true);
        }
        break;
      }
      case 'presence_update': {
        if (event.online) online.add(event.userId);
        else online.delete(event.userId);
        renderMembers();
        break;
      }
      case 'user_update': {
        const updated = event.user;
        if (updated.id === me.id) me = updated;
        guilds = guilds.map((g) => ({ ...g, members: g.members.map((m) => (m.id === updated.id ? updated : m)) }));
        for (const list of messages.values()) {
          list.forEach((m, i) => {
            if (m.author.id === updated.id) list[i] = { ...m, author: updated };
          });
        }
        renderUserBar();
        renderMembers();
        renderMessages(true);
        break;
      }
      case 'typing': {
        const channelTyping = typing.get(event.channelId) ?? new Map();
        typing.set(event.channelId, channelTyping);
        clearTyping(event.channelId, event.user.id);
        const timer = window.setTimeout(() => {
          clearTyping(event.channelId, event.user.id);
          renderTyping();
        }, TYPING_TTL_MS);
        channelTyping.set(event.user.id, { name: event.user.displayName, timer });
        renderTyping();
        break;
      }
      case 'notice':
        toast(event.message);
        break;
      case 'error':
        toast(event.message);
        break;
      case 'auth_ok':
      case 'password_changed':
      case 'guild_settings':
        break;
    }
  }

  function handleStatus(status: GatewayStatus): void {
    banner.hidden = status !== 'reconnecting';
  }

  // Only the clock format affects already-rendered messages; theme, font and density are pure CSS.
  const stopSettingsListener = onSettingsChange((settings) => {
    if (settings.clock !== lastClock) {
      lastClock = settings.clock;
      renderMessages(true);
    }
  });

  renderAll();

  return {
    handleEvent,
    handleStatus,
    handleBack: () => closeTopModal() || closeDrawers(),
    destroy() {
      stopSettingsListener();
      while (closeTopModal());
      clearPending();
      typing.forEach((byUser) => byUser.forEach((t) => window.clearTimeout(t.timer)));
      clear(root);
    }
  };
}

// ------------------------------------------------------------------ helpers

interface MessageContext {
  onProfile(user: PublicUser): void;
  canDelete(message: MessageDTO): boolean;
  onDelete(message: MessageDTO): void;
  onImage(attachment: AttachmentDTO): void;
}

function messageNode(message: MessageDTO, previous: MessageDTO | undefined, context: MessageContext): HTMLElement {
  const compact =
    previous !== undefined &&
    previous.author.id === message.author.id &&
    message.timestamp - previous.timestamp < COMPACT_WINDOW_MS;

  const body: Node[] = [];
  if (message.content) body.push(el('div', { class: 'msg-text' }, message.content));
  if (message.attachments.length > 0) {
    body.push(
      el(
        'div',
        { class: 'msg-attachments' },
        ...message.attachments.map((attachment) =>
          el(
            'button',
            { class: 'image-btn', type: 'button', title: attachment.name, onclick: () => context.onImage(attachment) },
            el('img', {
              class: 'msg-image',
              src: mediaUrl(attachment.url),
              alt: attachment.name,
              loading: 'lazy',
              width: attachment.width || undefined,
              height: attachment.height || undefined
            })
          )
        )
      )
    );
  }

  const actions = context.canDelete(message)
    ? el(
        'div',
        { class: 'msg-actions' },
        el(
          'button',
          {
            class: 'icon-btn danger-text',
            title: 'Delete message',
            'aria-label': 'Delete message',
            onclick: () => context.onDelete(message)
          },
          icon('trash', 16)
        )
      )
    : null;

  if (compact) {
    return el(
      'div',
      { class: 'msg grouped' },
      el('time', { class: 'msg-gutter-time', title: fullTime(message.timestamp) }, shortTime(message.timestamp)),
      el('div', { class: 'msg-body' }, ...body),
      actions
    );
  }
  const open = () => context.onProfile(message.author);
  return el(
    'div',
    { class: 'msg' },
    el(
      'button',
      { class: 'avatar-btn', 'aria-label': `View ${message.author.displayName}'s profile`, onclick: open },
      avatar(message.author, 'md')
    ),
    el(
      'div',
      { class: 'msg-body' },
      el(
        'div',
        { class: 'msg-meta' },
        el('button', { class: 'msg-author', title: `@${message.author.username}`, onclick: open }, message.author.displayName),
        message.author.bot ? el('span', { class: 'badge bot' }, icon('bot', 12), 'BOT') : null,
        el('time', { class: 'msg-time' }, fullTime(message.timestamp))
      ),
      ...body
    ),
    actions
  );
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' });

function shortTime(timestamp: number): string {
  const { clock } = getSettings();
  let format = timeFormats.get(clock);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: clock === 'auto' ? undefined : clock === '12'
    });
    timeFormats.set(clock, format);
  }
  return format.format(timestamp);
}

function fullTime(timestamp: number): string {
  const sameDay = new Date(timestamp).toDateString() === new Date().toDateString();
  return sameDay ? `Today at ${shortTime(timestamp)}` : `${dateFormat.format(timestamp)} ${shortTime(timestamp)}`;
}
