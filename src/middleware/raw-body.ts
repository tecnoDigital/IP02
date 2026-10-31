import type { Request, Response, NextFunction } from 'express';

export function rawBodyMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (req.path !== '/webhooks/retell') {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(Buffer.concat(chunks)) + Buffer.byteLength(chunk) > 1024 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', (err) => {
    next(err);
  });
}
