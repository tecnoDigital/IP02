import type { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  // Capture before mounted routers temporarily rewrite req.url/req.path.
  const path = req.path;
  // Unknown paths can themselves contain PII or credentials; do not echo them.
  const knownPaths = new Set(['/', '/auth', '/auth/', '/import', '/import/',
    '/api/auth/login', '/api/auth/logout', '/api/auth/session', '/api/health',
    '/api/contacts', '/api/contacts/', '/api/queue/status', '/api/queue/start',
    '/api/queue/pause', '/api/import/preview', '/api/import/confirm', '/webhooks/retell']);
  const sanitizedPath = knownPaths.has(path) ? path : '/:other';

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    if (status >= 200 && status < 300 && (
      (req.method === 'GET' && ['/api/contacts', '/api/contacts/', '/api/queue/status'].includes(path))
      || (req.method === 'POST' && path === '/webhooks/retell')
    )) return;
    const method = ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
    const message = `${method} ${sanitizedPath} ${status} ${duration}ms`;
    try {
      if (status >= 500) {
        console.error(message);
      } else if (status >= 400) {
        console.warn(message);
      } else {
        console.log(message);
      }
    } catch { /* Logging must not break request handling. */ }
  });

  next();
}
