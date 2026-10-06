import type { PublicUser } from '../shared/protocol';
import { el, initials } from './dom';
import { mediaUrl } from './media';

export type AvatarSize = 'sm' | 'md' | 'xl';

type AvatarUser = Pick<PublicUser, 'id' | 'displayName' | 'color'> & {
  /** Upload id, or any image URL (e.g. a local blob: preview). */
  avatar?: string | null;
};

/** Round avatar: the profile photo when there is one, otherwise initials on the user's colour. */
export function avatar(user: AvatarUser, size: AvatarSize, online = false): HTMLElement {
  const node = el('div', { class: `avatar ${size}`, 'aria-hidden': 'true' }, initials(user.displayName));
  node.style.background = user.color;
  if (user.avatar) {
    const image = el('img', { class: 'avatar-img', src: mediaUrl(user.avatar), alt: '', draggable: 'false' });
    // If the photo can't be loaded, the initials underneath show through.
    image.addEventListener('error', () => image.remove());
    node.append(image);
  }
  if (online) node.classList.add('is-online');
  return node;
}

/** Community icon for the left rail: an uploaded image or the name's initials. */
export function guildIconContent(guild: { name: string; icon: string | null }): Node {
  if (!guild.icon) return document.createTextNode(initials(guild.name));
  const image = el('img', { class: 'guild-img', src: mediaUrl(guild.icon), alt: '', draggable: 'false' });
  return image;
}
