import { UPLOAD_MAX_BYTES, type UploadKind, type UploadResponse } from '../shared/protocol';
import { chooseImage, prepareImage, type PreparedImage } from './images';

let base = '';

/** Points media URLs at the connected server (`ws://host:port` becomes `http://host:port`). */
export function setMediaBase(serverUrl: string): void {
  base = serverUrl.replace(/^ws/i, 'http').replace(/\/+$/, '');
}

const ID_RE = /^[0-9a-f]{32}$/;

/**
 * Resolves an upload id or server path to a URL the browser can load.
 * Local previews (blob:, data:) and absolute URLs pass through unchanged.
 */
export function mediaUrl(value: string): string {
  if (ID_RE.test(value)) return `${base}/files/${value}`;
  if (value.startsWith('/')) return `${base}${value}`;
  return value;
}

/** Uploads an image over HTTP. Resolves to the upload id to reference in a WebSocket event. */
export async function uploadImage(token: string, kind: UploadKind, image: PreparedImage): Promise<UploadResponse> {
  const query = new URLSearchParams({
    kind,
    name: image.name,
    w: String(image.width),
    h: String(image.height)
  });
  let response: Response;
  try {
    response = await fetch(`${base}/upload?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': image.blob.type || 'application/octet-stream' },
      body: image.blob
    });
  } catch {
    throw new Error('Could not reach the server to upload the image.');
  }
  const body = (await response.json().catch(() => ({}))) as Partial<UploadResponse> & { error?: string };
  if (!response.ok || !body.id) throw new Error(body.error ?? `Upload failed (${response.status}).`);
  return body as UploadResponse;
}

/**
 * Lets the user pick a photo, crops it to a square and uploads it as an avatar or community icon.
 * Resolves to null if they cancelled. The caller owns (and should eventually revoke) `previewUrl`.
 */
export async function pickAndUploadSquare(
  token: string,
  kind: 'avatar' | 'icon'
): Promise<{ id: string; previewUrl: string } | null> {
  const file = await chooseImage();
  if (!file) return null;
  const prepared = await prepareImage(file, { maxSide: 256, square: true, maxBytes: UPLOAD_MAX_BYTES[kind] });
  try {
    const { id } = await uploadImage(token, kind, prepared);
    return { id, previewUrl: prepared.previewUrl };
  } catch (error) {
    URL.revokeObjectURL(prepared.previewUrl);
    throw error;
  }
}
