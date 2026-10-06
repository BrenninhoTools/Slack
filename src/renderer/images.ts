export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  name: string;
  /** Local blob: URL for showing the image before (and while) it uploads. Revoke it when done. */
  previewUrl: string;
}

export interface PrepareOptions {
  /** Longest allowed side in px; larger images are scaled down. */
  maxSide: number;
  /** Hard size limit for the result. */
  maxBytes: number;
  /** Centre-crop to a square (avatars and community icons). */
  square?: boolean;
}

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const SUPPORTED = new Set(IMAGE_ACCEPT.split(','));

export const isSupportedImage = (file: Blob): boolean => SUPPORTED.has(file.type);

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

async function decode(file: Blob): Promise<Decoded> {
  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // fall through to the <img> path
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('That file could not be read as an image.');
  }
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process the image.'))), 'image/jpeg', quality)
  );
}

/**
 * Validates an image and shrinks it in the browser before upload. Phone photos are often 5-15 MB;
 * this keeps uploads fast and well under the server limits. Small images are sent untouched,
 * which also preserves GIF animation.
 */
export async function prepareImage(file: File, options: PrepareOptions): Promise<PreparedImage> {
  if (!isSupportedImage(file)) throw new Error('Please choose a PNG, JPEG, GIF or WebP image.');

  const image = await decode(file);
  try {
    const needsResize = options.square === true || Math.max(image.width, image.height) > options.maxSide;
    if (!needsResize && file.size <= options.maxBytes) {
      return {
        blob: file,
        width: image.width,
        height: image.height,
        name: file.name,
        previewUrl: URL.createObjectURL(file)
      };
    }
    if (file.type === 'image/gif' && !options.square) {
      throw new Error(`That GIF is larger than ${Math.round(options.maxBytes / 1024 / 1024)} MB.`);
    }

    // Crop (optional) then scale into a canvas and re-encode as JPEG.
    let sx = 0;
    let sy = 0;
    let sw = image.width;
    let sh = image.height;
    if (options.square) {
      const side = Math.min(sw, sh);
      sx = (sw - side) / 2;
      sy = (sh - side) / 2;
      sw = sh = side;
    }
    const scale = Math.min(1, options.maxSide / Math.max(sw, sh));
    const width = Math.max(1, Math.round(sw * scale));
    const height = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the image.');
    context.fillStyle = '#ffffff'; // JPEG has no transparency
    context.fillRect(0, 0, width, height);
    context.drawImage(image.source, sx, sy, sw, sh, 0, 0, width, height);

    let blob = await toBlob(canvas, 0.88);
    if (blob.size > options.maxBytes) blob = await toBlob(canvas, 0.6);
    if (blob.size > options.maxBytes) throw new Error('That image is too large.');

    return {
      blob,
      width,
      height,
      name: `${file.name.replace(/\.[^.]+$/, '') || 'image'}.jpg`,
      previewUrl: URL.createObjectURL(blob)
    };
  } finally {
    image.release();
  }
}

/** Opens the system file/photo picker. Resolves to the chosen image, or null if the user cancelled. */
export function chooseImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_ACCEPT;
    input.hidden = true;
    // Attached to the page because some mobile webviews ignore clicks on detached inputs.
    document.body.append(input);
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}
