import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, extname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getAsset, getAssetKeys } from 'node:sea';
import type { AppConfig } from './types.ts';
import { Database, resolveDatabasePath } from './db.ts';
import { requestLogger } from './middleware/logger.ts';
import { errorHandler } from './middleware/error-handler.ts';
import { buildSessionMiddleware, requireAuth } from './middleware/auth.ts';
import { createRetellClient, createMockRetellClient, type RetellClient } from './services/retell.ts';
import { createQueue } from './services/queue.ts';
import { runRecovery } from './services/recovery.ts';
import { createImportRoutes } from './routes/import.ts';
import { createContactsRoutes } from './routes/contacts.ts';
import { createQueueRoutes } from './routes/queue.ts';
import { createWebhookRoutes } from './routes/webhooks.ts';
import { createAuthRoutes } from './routes/auth.ts';
import { createHistoryRoutes } from './routes/history.ts';

// CommonJS bundles have __dirname; source modules use import.meta.url.
const moduleDirectory = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
const frontendPath = resolve(moduleDirectory, '../dist/frontend');

export function loadConfig(): AppConfig {
  const local = process.argv.includes('--local');
  // Local mode never loads credentials from disk or enables the provider.
  if (!local) dotenv.config();
  const smoke = process.argv.includes('--smoke');
  return {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    databasePath: resolveDatabasePath(process.env.DATABASE_PATH),
    appBaseUrl: local ? `http://127.0.0.1:${Number(process.env.PORT || 3000)}` : process.env.APP_BASE_URL || 'http://127.0.0.1:3000',
    retellApiKey: local ? undefined : process.env.RETELL_API_KEY,
    retellWebhookKey: local ? undefined : process.env.RETELL_WEBHOOK_KEY,
    retellFromNumber: local ? undefined : process.env.RETELL_FROM_NUMBER,
    retellAgentId: local ? undefined : process.env.RETELL_AGENT_ID,
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
    sessionSecret: process.env.SESSION_SECRET,
    activeCallStaleSeconds: Number(process.env.ACTIVE_CALL_STALE_SECONDS || 300),
    importMaxBytes: Number(process.env.IMPORT_MAX_BYTES || 1024 * 1024),
    importMaxRows: Number(process.env.IMPORT_MAX_ROWS || 10000),
    smoke,
    local,
  };
}

export function createApp(config: AppConfig, db: Database, injected?: { retell: RetellClient }): express.Express {
  const app = express();
  const retell = injected?.retell ?? (config.local ? createMockRetellClient() : createRetellClient(config));
  const queue = createQueue(db, retell, config);
  app.set('queue', queue);

  app.disable('x-powered-by');
  const https = config.appBaseUrl.startsWith('https://');
  // Only a local reverse proxy may assert the original HTTPS protocol.
  if (https) app.set('trust proxy', 'loopback');
  app.use(cors({ origin: https ? new URL(config.appBaseUrl).origin : true, credentials: true }));
  app.use(express.json({
    limit: '1mb',
    verify: (req: express.Request, _res: express.Response, buf: Buffer) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  app.use(requestLogger);
  app.use(buildSessionMiddleware(config));

  const auth = requireAuth(config);

  // Webhook route must bypass auth but still receive raw body.
  if (!config.local) app.use('/webhooks', createWebhookRoutes(config, db));

  // Public routes
  app.use('/api/auth', createAuthRoutes(config));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // Protected operator routes
  app.use('/api/import', auth, createImportRoutes(config, db));
  app.use('/api/contacts', auth, createContactsRoutes(config, db, queue));
  app.use('/api/queue', auth, createQueueRoutes(queue, !config.local));
  app.use('/api/history', auth, createHistoryRoutes(db));

  // Static assets: prefer SEA assets, fall back to dist/frontend for dev/tests.
  if (!process.argv.includes('--dev')) {
    app.use(express.static(frontendPath));
    app.use(serveSeaAssetOrFallback);
  }

  app.use(errorHandler);

  // Start worker loop
  if (!config.smoke && !config.local) {
    runRecovery(db, retell, config).catch(() => {});
    const interval = setInterval(() => queue.tick().catch(() => {}), 2000);
    app.set('workerInterval', interval);
  }

  return app;
}

function serveSeaAssetOrFallback(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
  let path = req.path;
  if (path === '/') path = '/index.html';
  const pageRequest = ['/', '/auth', '/auth/', '/import', '/import/', '/history', '/history/'].includes(req.path);

  // In dev/tests, dist/frontend may exist; try that first.
  const devPath = resolve(frontendPath, 'index.html');
  if (pageRequest && existsSync(devPath)) {
    res.set('Content-Type', 'text/html');
    res.send(readFileSync(devPath));
    return;
  }

  // Try SEA assets.
  try {
    const keys = getAssetKeys();
    if (keys.includes(path.slice(1))) {
      res.set('Content-Type', contentTypeFor(path));
      res.send(Buffer.from(getAsset(path.slice(1))));
      return;
    }
    if (pageRequest && keys.includes('index.html')) {
      res.set('Content-Type', 'text/html');
      res.send(Buffer.from(getAsset('index.html')));
      return;
    }
  } catch {
    // SEA not available in dev.
  }

  next();
}

function contentTypeFor(path: string): string {
  const ext = extname(path);
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

export async function runSmoke(config: AppConfig): Promise<void> {
  const db = new Database(':memory:');
  const app = createApp(config, db);
  const server = app.listen(config.port, '127.0.0.1', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      const htmlRes = await fetch(`http://127.0.0.1:${config.port}/`);
      if (!htmlRes.ok) throw new Error(`Dashboard check failed: ${htmlRes.status}`);
      const body = await htmlRes.text();
      if (!body.includes('<div id="root"></div>')) throw new Error('Dashboard HTML not served');
      console.log('SMOKE OK');
      server.close(() => {
        db.close();
        process.exit(0);
      });
    } catch (err) {
      console.error('SMOKE FAILED', err);
      server.close(() => {
        db.close();
        process.exit(1);
      });
    }
  });
}

export function main(): void {
  const config = loadConfig();
  if (config.smoke) {
    runSmoke(config).catch(() => process.exit(1));
    return;
  }
  const db = new Database(config.databasePath);
  const app = createApp(config, db);
  const host = config.local || process.argv.includes('--dev') ? '127.0.0.1' : config.host || '0.0.0.0';
  const server = app.listen(config.port, host, () => {
    console.log(`Server listening on ${config.appBaseUrl} (mode: ${config.local ? 'local, mock calls' : 'normal'}). Check the development launcher for test database scope.`);
  });

  function shutdown() {
    console.log('Shutting down...');
    const interval = app.get('workerInterval') as NodeJS.Timeout | undefined;
    if (interval) clearInterval(interval);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
