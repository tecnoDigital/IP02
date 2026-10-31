import { randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import cookieSession from 'cookie-session';
import type { AppConfig } from '../types.ts';

const COOKIE_NAME = 'sid';

export function requireAuth(config: AppConfig) {
  if (!config.sessionSecret) {
    throw new Error('SESSION_SECRET is required for operator authentication');
  }

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.path === '/webhooks/retell') {
      next();
      return;
    }

    const session = req.session as { authenticated?: boolean; operatorId?: string } | null | undefined;
    if (!session || !session.authenticated) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    (req as Request & { operatorId?: string }).operatorId = session.operatorId;
    next();
  };
}

export function buildSessionMiddleware(config: AppConfig) {
  if (!config.sessionSecret) {
    throw new Error('SESSION_SECRET is required');
  }
  return cookieSession({
    name: COOKIE_NAME,
    keys: [config.sessionSecret],
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appBaseUrl.startsWith('https://'),
    signed: true,
  });
}

export function verifyPassword(password: string, hash: string): boolean {
  const parts = hash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(32);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function createLoginHandler(config: AppConfig) {
  return function loginHandler(req: Request, res: Response): void {
    if (!config.adminPasswordHash) {
      res.status(503).json({ error: 'Authentication not configured' });
      return;
    }
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'Password required' });
      return;
    }

    const ok = verifyPassword(password, config.adminPasswordHash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const operatorId = randomBytes(16).toString('hex');
    req.session = { authenticated: true, operatorId };
    res.status(204).send();
  };
}

export function createLogoutHandler(_config: AppConfig) {
  return function logoutHandler(req: Request, res: Response): void {
    req.session = null;
    res.status(204).send();
  };
}

export function createSessionStatusHandler(_config: AppConfig) {
  return function sessionStatusHandler(req: Request, res: Response): void {
    const authenticated = !!req.session?.authenticated;
    res.json({ authenticated });
  };
}
