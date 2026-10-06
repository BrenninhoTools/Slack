import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identifies an image from its first bytes. The client-supplied Content-Type is never trusted, and
 * SVG is deliberately not accepted (it can carry scripts).
 */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const head = buf.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export const FILE_ID_RE = /^[0-9a-f]{32}$/;

/** Stores uploaded files on disk, one file per id (no extension). Ids are validated before touching the disk. */
export class MediaStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  pathFor(id: string): string {
    if (!FILE_ID_RE.test(id)) throw new Error('Invalid file id');
    return join(this.dir, id);
  }

  write(id: string, data: Buffer): void {
    writeFileSync(this.pathFor(id), data);
  }

  exists(id: string): boolean {
    return FILE_ID_RE.test(id) && existsSync(this.pathFor(id));
  }

  remove(id: string): void {
    if (FILE_ID_RE.test(id)) rmSync(this.pathFor(id), { force: true });
  }
}
