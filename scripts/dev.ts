import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { developmentEnvironmentMessage, prepareTestEnvironment } from './test-environment.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const backendPort = 3000;
let backend: ChildProcess | undefined;
let vite: ViteDevServer | undefined;
let stopping = false;
let monitor: NodeJS.Timeout | undefined;
let releaseTestLock: (() => void) | undefined;
const testMode = process.argv.includes('--test');

async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (monitor) clearInterval(monitor);
  const pid = backend?.pid;
  if (pid) {
    if (process.platform === 'win32') {
      // Killing only the watcher leaves its server child alive on Windows.
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('error', () => resolve());
        killer.once('exit', () => resolve());
      });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* Already stopped. */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
  }
  await vite?.close();
  releaseTestLock?.();
  process.exit(code);
}

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.json()).status === 'ok';
  } catch { return false; }
}

async function start(): Promise<void> {
  if (testMode) {
    if (process.argv.length !== 3) throw new Error('Use npm run dev:test without extra arguments.');
    const fixture = prepareTestEnvironment(root);
    releaseTestLock = fixture.release;
    process.env = fixture.env;
  }
  // Check both ports before starting either service; never silently move ports.
  await requireFreePort(backendPort);
  await requireFreePort(5173);
  if (stopping) return;
  console.log(developmentEnvironmentMessage(testMode, process.argv.includes('--local')));
  vite = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), envFile: false });
  if (stopping) { await vite.close(); return; }
  backend = spawn(process.execPath, [
    '--watch', '--watch-preserve-output', '--import', 'tsx',
    fileURLToPath(new URL('../src/index.ts', import.meta.url)), '--dev',
    ...(testMode ? ['--local'] : process.argv.slice(2)),
  ], {
    cwd: root,
    env: { ...process.env, PORT: String(backendPort), APP_BASE_URL: 'http://127.0.0.1:5173' },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  backend.once('error', (error) => { console.error(error); void stop(1); });
  backend.once('exit', (code) => {
    if (!stopping) { console.error(`Backend watcher exited (${code}).`); void stop(1); }
  });
  const deadline = Date.now() + 15000;
  while (!stopping && !await healthy()) {
    if (Date.now() >= deadline) throw new Error('Backend failed to become healthy within 15 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (stopping) return;
  await vite.listen();
  vite.printUrls();
  console.log('Backend: http://127.0.0.1:3000; open http://127.0.0.1:5173. Ctrl+C stops both.');
  // Native watch stays alive after a failed restart. Bound the outage, then stop both services.
  let failures = 0;
  let checking = false;
  monitor = setInterval(() => {
    if (checking || stopping) return;
    checking = true;
    void healthy().then((ok) => {
      failures = ok ? 0 : failures + 1;
      if (failures >= 10) {
        console.error('Backend unavailable after restart; stopping development services.');
        void stop(1);
      }
    }).finally(() => { checking = false; });
  }, 1000);
}

process.on('SIGINT', () => { void stop(0); });
process.on('SIGTERM', () => { void stop(0); });
// Test harnesses may use IPC for graceful Windows shutdown, where kill(SIGTERM) is forced.
process.on('message', (message) => { if (message === 'shutdown') void stop(0); });
start().catch((error) => { console.error(error); void stop(1); });
