import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { DatabaseService } from '../database/DatabaseService';
import { logger } from '../utils/logger';
import { LinkAcceptance } from '../utils/linkAcceptance';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const MAX_BODY = 16 * 1024;
const MAX_INIT_DATA = 16 * 1024;
const MAX_LINKS = 10;
const AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;

type AuthUser = { id: number; username?: string; first_name?: string; last_name?: string };
type TelegramInitData = { user: AuthUser; authDate: number };

export function parseTelegramInitData(raw: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): TelegramInitData | null {
  if (!raw || !botToken || raw.length > MAX_INIT_DATA) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    const userRaw = params.get('user');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
    if (!Number.isSafeInteger(authDate) || authDate <= 0 || !userRaw) return null;
    const age = nowSeconds - authDate;
    if (age < -300 || age > AUTH_MAX_AGE_SECONDS) return null;
    const dataCheckString = [...params.entries()].filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
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

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  applySecurityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  let body = '';
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

function normalizeUrl(url: string): string {
  try {
    const value = new URL(url);
    value.hostname = value.hostname.toLowerCase().replace(/^www\./, '');
    value.protocol = 'https:';
    return value.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function startWebAppServer(port: number, db: DatabaseService, botToken: string, webRoot = join(process.cwd(), 'web')): { close: () => Promise<void> } {
  const server = createServer(async (req, res) => {
    let requestPath = '';
    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      requestPath = decodeURIComponent(requestUrl.pathname);

      if (requestPath === '/health' || requestPath === '/healthz') {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(res, 405, { error: 'method_not_allowed' }); return; }
        json(res, 200, { status: 'ok', service: 'hunt-web' }); return;
      }

      if (requestPath.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
          res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
          json(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const initData = req.headers['x-telegram-init-data'];
        const auth = parseTelegramInitData(typeof initData === 'string' ? initData : '', botToken);
        if (!auth) { logger.warn('HUNT API unauthorized request', { requestPath, method: req.method }); json(res, 401, { error: 'unauthorized' }); return; }
        const user = await db.getUser(auth.user.id);
        if (!user) { logger.warn('HUNT API user not registered', { telegramId: auth.user.id, requestPath }); json(res, 403, { error: 'user_not_registered' }); return; }

        if (requestPath === '/api/bootstrap' && req.method === 'GET') {
          const [links, ads, priceDrops, stats, statsByLink] = await Promise.all([
            db.getUserLinks(user.id), db.getDashboardAds(user.id, 50), db.getDashboardPriceDrops(user.id, 30),
            db.getDashboardStats(user.id), db.getUserAdsCount(user.id),
          ]);
          logger.info('HUNT bootstrap', { telegramId: auth.user.id, dbUserId: user.id, links: links.length, ads: ads.length, priceDrops: priceDrops.length, totalLinks: stats.totalLinks, activeLinks: stats.activeLinks });
          json(res, 200, { user: { id: user.id, telegramId: user.telegram_id, username: user.username }, links, ads, priceDrops, stats, statsByLink, serverTime: new Date().toISOString() });
          return;
        }

        if (requestPath === '/api/links' && req.method === 'POST') {
          let body: Record<string, unknown>;
          try { body = await readJson(req); }
          catch (error: unknown) { json(res, error instanceof Error && error.message === 'body_too_large' ? 413 : 400, { error: error instanceof Error && error.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' }); return; }
          const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
          if (!rawUrl || rawUrl.length > 4096) { json(res, 400, { error: 'invalid_url' }); return; }
          const url = normalizeUrl(rawUrl);
          const assessment = LinkAcceptance.assess(url);
          if (!assessment.ok || !assessment.platform) { json(res, 400, { error: 'unsupported_url', message: assessment.reason || 'Поддерживаются страницы поиска Kufar, Onliner и av.by.' }); return; }
          const links = await db.getUserLinks(user.id);
          const existing = links.find(link => link.url === url);
          if (existing) {
            if (!existing.is_active) {
              await db.setLinkActive(existing.id, user.id, true);
              logger.info('HUNT monitor reactivated', { telegramId: auth.user.id, dbUserId: user.id, linkId: existing.id, platform: existing.platform });
              json(res, 200, { link: { ...existing, is_active: true }, reactivated: true });
              return;
            }
            json(res, 409, { error: 'duplicate', message: 'Эта ссылка уже добавлена.' });
            return;
          }
          if (links.length >= MAX_LINKS) { json(res, 409, { error: 'limit_reached', message: `Достигнут лимит в ${MAX_LINKS} мониторов.` }); return; }
          const link = await db.createLink(user.id, url, assessment.platform);
          logger.info('HUNT monitor created', { telegramId: auth.user.id, dbUserId: user.id, linkId: link.id, platform: link.platform, url: link.url });
          json(res, 201, { link, reactivated: false });
          return;
        }

        const linkMatch = requestPath.match(/^\/api\/links\/(\d+)$/);
        if (linkMatch && req.method === 'PATCH') {
          let body: Record<string, unknown>;
          try { body = await readJson(req); }
          catch (error: unknown) { json(res, error instanceof Error && error.message === 'body_too_large' ? 413 : 400, { error: error instanceof Error && error.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' }); return; }
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

      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(res, 405, { error: 'method_not_allowed' }); return; }
      const relativePath = requestPath === '/' ? '/index.html' : requestPath;
      const normalizedPath = normalize(relativePath).replace(/^[/\\]+/, '');
      if (normalizedPath.startsWith('..')) { json(res, 400, { error: 'bad_request' }); return; }
      const filePath = join(webRoot, normalizedPath);
      const body = await readFile(filePath);
      const extension = extname(filePath).toLowerCase();
      applySecurityHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
      res.setHeader('Cache-Control', extension === '.html' ? 'no-cache' : 'public, max-age=300');
      res.end(body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'body_too_large') { json(res, 413, { error: 'body_too_large' }); return; }
      if (requestPath.startsWith('/api/')) { logger.error('HUNT API request failed', { requestPath, error: message }); json(res, 500, { error: 'internal_error' }); return; }
      res.statusCode = 404;
      applySecurityHeaders(res);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
    }
  });

  server.listen(port, '0.0.0.0', () => logger.info('HUNT WebApp server started', { port, webRoot }));
  return { close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))) };
}
