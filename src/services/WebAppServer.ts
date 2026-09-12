import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { DatabaseService } from '../database/DatabaseService';
import { logger } from '../utils/logger';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const MAX_BODY = 16 * 1024;
const AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;
type AuthUser = { id: number; username?: string; first_name?: string; last_name?: string };
type TelegramInitData = { user: AuthUser; authDate: number };

function parseTelegramInitData(raw: string, botToken: string): TelegramInitData | null {
  if (!raw || !botToken) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    const userRaw = params.get('user');
    if (!hash || !Number.isSafeInteger(authDate) || !userRaw) return null;
    if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > AUTH_MAX_AGE_SECONDS) return null;
    const dataCheckString = [...params.entries()]
      .filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
    const actual = Buffer.from(hash, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) return null;
    const user = JSON.parse(userRaw) as AuthUser;
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return { user, authDate };
  } catch { return null; }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; let body = '';
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY) throw new Error('body_too_large');
    body += part.toString('utf8');
  }
  const parsed: unknown = JSON.parse(body || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
  return parsed as Record<string, unknown>;
}

export function startWebAppServer(port: number, db: DatabaseService, botToken: string, webRoot = join(process.cwd(), 'web')): { close: () => Promise<void> } {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      const requestPath = decodeURIComponent(requestUrl.pathname);
      if (requestPath === '/health' || requestPath === '/healthz') { json(res, 200, { status: 'ok', service: 'hunt-web' }); return; }

      if (requestPath.startsWith('/api/')) {
        const initData = req.headers['x-telegram-init-data'];
        const auth = parseTelegramInitData(typeof initData === 'string' ? initData : '', botToken);
        if (!auth) { json(res, 401, { error: 'unauthorized' }); return; }
        const user = await db.getUser(auth.user.id);
        if (!user) { json(res, 403, { error: 'user_not_registered' }); return; }

        if (requestPath === '/api/bootstrap' && req.method === 'GET') {
          const [links, ads, priceDrops, stats] = await Promise.all([
            db.getUserLinks(user.id), db.getDashboardAds(user.id, 50), db.getDashboardPriceDrops(user.id, 30), db.getDashboardStats(user.id),
          ]);
          json(res, 200, { user: { id: user.id, telegramId: user.telegram_id, username: user.username }, links, ads, priceDrops, stats, serverTime: new Date().toISOString() });
          return;
        }
        const linkMatch = requestPath.match(/^\/api\/links\/(\d+)$/);
        if (linkMatch && req.method === 'PATCH') {
          const body = await readJson(req);
          if (typeof body.is_active !== 'boolean') { json(res, 400, { error: 'is_active_required' }); return; }
          const ok = await db.setLinkActive(Number(linkMatch[1]), user.id, body.is_active);
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not_found' }); return;
        }
        if (linkMatch && req.method === 'DELETE') {
          const ok = await db.deleteLink(Number(linkMatch[1]), user.id);
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not_found' }); return;
        }
        json(res, 404, { error: 'not_found' }); return;
      }

      const relativePath = requestPath === '/' ? '/index.html' : requestPath;
      const normalizedPath = normalize(relativePath).replace(/^[/\\]+/, '');
      if (normalizedPath.startsWith('..')) { json(res, 400, { error: 'bad_request' }); return; }
      const filePath = join(webRoot, normalizedPath);
      const body = await readFile(filePath);
      const extension = extname(filePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
      res.setHeader('Cache-Control', extension === '.html' ? 'no-cache' : 'public, max-age=300');
      res.end(body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'body_too_large') { json(res, 413, { error: 'body_too_large' }); return; }
      if (requestPathFrom(req).startsWith('/api/')) { json(res, 500, { error: 'internal_error' }); return; }
      res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not found');
    }
  });
  server.listen(port, '0.0.0.0', () => logger.info('HUNT WebApp server started', { port, webRoot }));
  return { close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function requestPathFrom(req: IncomingMessage): string {
  try { return new URL(req.url || '/', 'http://localhost').pathname; } catch { return ''; }
}
