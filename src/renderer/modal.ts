import { el } from './dom';

/** Open dialogs, bottom to top. Dialogs stack so a confirmation can appear over a settings page. */
const stack: Array<() => void> = [];

export interface ModalOptions {
  /** Larger dialog (used by settings). Full-screen on phones either way. */
  wide?: boolean;
  /** Hide the default title bar; the content provides its own header. */
  bare?: boolean;
  /** Extra class on the dialog box. */
  className?: string;
  onClose?: () => void;
}

/** Opens a dialog on top of `root`. Returns a function that closes it. */
export function openModal(
  root: HTMLElement,
  title: string,
  content: Node[],
  options: ModalOptions = {}
): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && stack[stack.length - 1] === close) close();
  };
  const overlay = el(
    'div',
    { class: 'modal-overlay', onmousedown: (event: MouseEvent) => event.target === overlay && close() },
    el(
      'div',
      {
        class: `modal${options.wide ? ' wide' : ''}${options.className ? ` ${options.className}` : ''}`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title
      },
      options.bare ? null : el('h2', {}, title),
      ...content
    )
  );

  function close(): void {
    const index = stack.indexOf(close);
    if (index === -1) return;
    stack.splice(index, 1);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    options.onClose?.();
  }

  document.addEventListener('keydown', onKey);
  stack.push(close);
  root.append(overlay);
  overlay.querySelector<HTMLElement>('input:not([type=file]), textarea')?.focus();
  return close;
}

/** Closes the topmost dialog, if any. Returns whether there was one (used for the Android back button). */
export function closeTopModal(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top();
  return true;
}

export const hasOpenModal = (): boolean => stack.length > 0;

/** Shows a short message. Several toasts stack instead of overlapping. */
export function toast(root: HTMLElement, text: string): void {
  let stackEl = root.querySelector<HTMLElement>(':scope > .toast-stack');
  if (!stackEl) {
    stackEl = el('div', { class: 'toast-stack' });
    root.append(stackEl);
  }
  const node = el('div', { class: 'toast', role: 'status' }, text);
  stackEl.append(node);
  window.setTimeout(() => {
    node.remove();
    if (stackEl?.childElementCount === 0) stackEl.remove();
  }, 4000);
}

export interface PromptOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /** Show a text field; the promise resolves to its value. */
  input?: { placeholder: string; maxLength: number };
  danger?: boolean;
}

/**
 * Asks for confirmation (and optionally a line of text).
 * Resolves to the entered text ('' without an input) or null if cancelled.
 */
export function promptDialog(root: HTMLElement, options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const field = options.input
      ? el('input', { type: 'text', maxlength: options.input.maxLength, placeholder: options.input.placeholder })
      : null;
    const confirm = el('button', { class: `btn ${options.danger ? 'danger' : 'primary'}`, type: 'submit' }, options.confirmLabel);
    const cancel = el('button', { class: 'btn secondary', type: 'button', onclick: () => close() }, 'Cancel');

    const close = openModal(
      root,
      options.title,
      [
        el(
          'form',
          {
            onsubmit: (event: Event) => {
              event.preventDefault();
              finish(field?.value.trim() ?? '');
              close();
            }
          },
          el('p', { class: 'muted' }, options.message),
          field,
          el('div', { class: 'form-actions' }, confirm, cancel)
        )
      ],
      { onClose: () => finish(null) }
    );
    (field ?? confirm).focus();
  });
}

export const confirmDialog = async (
  root: HTMLElement,
  options: Omit<PromptOptions, 'input'>
): Promise<boolean> => (await promptDialog(root, options)) !== null;

/** Full-size image viewer. */
export function openLightbox(root: HTMLElement, src: string, name: string): void {
  const image = el('img', { class: 'lightbox-img', src, alt: name });
  const close = openModal(
    root,
    name,
    [
      image,
      el(
        'a',
        { class: 'lightbox-link', href: src, target: '_blank', rel: 'noopener noreferrer' },
        'Open original'
      )
    ],
    { bare: true, className: 'lightbox' }
  );
  image.addEventListener('click', () => close());
}
