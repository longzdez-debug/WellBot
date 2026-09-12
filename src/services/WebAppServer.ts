import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { logger } from '../utils/logger';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export function startWebAppServer(port: number, webRoot = join(process.cwd(), 'web')): { close: () => Promise<void> } {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const relativePath = requestPath === '/' ? '/index.html' : requestPath;
      const safePath = normalize(relativePath).replace(/^([.][.][/\\])+/, '');
      const filePath = join(webRoot, safePath);
      const body = await readFile(filePath);
      const extension = extname(filePath).toLowerCase();

      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
      res.setHeader('Cache-Control', extension === '.html' ? 'no-cache' : 'public, max-age=300');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info('HUNT WebApp server started', { port, webRoot });
  });

  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
