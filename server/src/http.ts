import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { UPLOAD_MAX_BYTES, type UploadKind, type UploadResponse } from '../../src/shared/protocol';
import { FILE_ID_RE, sniffImage, type MediaStore } from './media';
import { StoreError, type Store } from './store';

const UPLOADS_PER_WINDOW = 30;
const UPLOAD_WINDOW_MS = 10 * 60_000;
const MAX_DIMENSION = 20_000;

export interface HttpDeps {
  store: Store;
  media: MediaStore;
  onlineUsers(): number;
}

/** HTTP side of the server: health check, image upload and image delivery. Everything else is the WebSocket. */
export function createRequestHandler({ store, media, onlineUsers }: HttpDeps): RequestListener {
  const uploadLog = new Map<string, number[]>();

  function uploadsExceeded(userId: string): boolean {
    const now = Date.now();
    const recent = (uploadLog.get(userId) ?? []).filter((t) => now - t < UPLOAD_WINDOW_MS);
    recent.push(now);
    uploadLog.set(userId, recent);
    return recent.length > UPLOADS_PER_WINDOW;
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > limit) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const header = req.headers.authorization ?? '';
    let userId: string;
    try {
      userId = store.resume(header.startsWith('Bearer ') ? header.slice(7) : '').id;
    } catch (err) {
      if (err instanceof StoreError) return json(res, 401, { error: err.message });
      throw err;
    }

    const kind = url.searchParams.get('kind') as UploadKind | null;
    if (!kind || !(kind in UPLOAD_MAX_BYTES)) return json(res, 400, { error: 'Unknown upload kind.' });
    if (uploadsExceeded(userId)) return json(res, 429, { error: 'You are uploading too many images. Try again later.' });

    const limit = UPLOAD_MAX_BYTES[kind];
    const body = await readBody(req, limit);
    if (!body) {
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: `Images can be at most ${Math.round(limit / 1024 / 1024)} MB.` }));
      req.destroy();
      return;
    }

    const mime = sniffImage(body);
    if (!mime) return json(res, 415, { error: 'Only PNG, JPEG, GIF and WebP images are supported.' });

    // Dimensions are layout hints supplied by the client; they are clamped and never trusted for anything else.
    const dimension = (name: string) => {
      const value = Math.round(Number(url.searchParams.get(name)));
      return Number.isFinite(value) ? Math.min(MAX_DIMENSION, Math.max(0, value)) : 0;
    };
    // eslint-disable-next-line no-control-regex
    const name = (url.searchParams.get('name') ?? '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 100) || 'image';

    const id = randomBytes(16).toString('hex');
    media.write(id, body);
    const info = { id, kind, mime, size: body.length, name, width: dimension('w'), height: dimension('h') };
    store.registerUpload(userId, info);

    const response: UploadResponse = {
      id,
      url: `/files/${id}`,
      mime,
      size: body.length,
      width: info.width,
      height: info.height
    };
    json(res, 201, response);
  }

  function serve(id: string, method: string, res: ServerResponse): void {
    const file = store.getFile(id);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    const path = media.pathFor(id);
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': statSync(path).size,
      // Ids are random and never reused, so the content can be cached forever.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin'
    });
    if (method === 'HEAD') res.end();
    else createReadStream(path).pipe(res);
  }

  return (req, res) => {
    // Clients are desktop/mobile shells served from file:// or localhost, so allow any origin.
    // Uploads are protected by the bearer token, not by the origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');

    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    const handle = async (): Promise<void> => {
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Max-Age': '600' }).end();
      } else if (url.pathname === '/health') {
        json(res, 200, { status: 'ok', online: onlineUsers() });
      } else if (method === 'POST' && url.pathname === '/upload') {
        await upload(req, res, url);
      } else if ((method === 'GET' || method === 'HEAD') && url.pathname.startsWith('/files/')) {
        const id = url.pathname.slice('/files/'.length);
        if (FILE_ID_RE.test(id)) serve(id, method, res);
        else res.writeHead(404).end();
      } else {
        res.writeHead(404).end();
      }
    };

    handle().catch((err) => {
      console.error('[http] unexpected error:', err);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
      else res.destroy();
    });
  };
}
