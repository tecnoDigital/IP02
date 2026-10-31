import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
import { hashPassword } from '../src/middleware/auth.ts';
import { Database } from '../src/db.ts';

export const testResetMessage = 'TEST database only: disposable contacts (including removed contacts), attempts and webhook history cleared. This does not reset a separate ordinary development database: DATABASE_PATH and npm run dev / dev:local configuration are ignored. Start npm run dev:test to use the reset database.';

export function developmentEnvironmentMessage(testMode: boolean, localMode: boolean): string {
  if (testMode) return 'Environment: TEST (disposable database, mock calls). Stop dev:test before npm run test:db:reset.';
  return `Environment: ${localMode ? 'LOCAL (mock calls)' : 'NORMAL'}. Database uses DATABASE_PATH or the AppData default. npm run test:db:reset only clears dev:test data; it does not follow this command's database configuration.`;
}

// No environment variable or command-line argument can redirect these paths.
export function testPaths(root: string) {
  const canonicalRoot = realpathSync(root);
  const directory = join(canonicalRoot, '.local-test');
  if (!existsSync(directory)) mkdirSync(directory);
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error('Test directory must be a real directory inside the project, not a link.');
  }
  const database = join(directory, 'browser-v2.sqlite');
  for (const name of ['browser-v2.sqlite', 'browser-v2.sqlite-wal', 'browser-v2.sqlite-shm', 'session-secret', 'owner.lock']) {
    const path = join(directory, name);
    // Reject dangling links, junctions, directories and hard links before any read/write.
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Unsafe test file: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { directory, database, lock: join(directory, 'owner.lock') };
}

export function acquireTestLock(root: string) {
  const paths = testPaths(root);
  let fd: number;
  try { fd = openSync(paths.lock, 'wx', 0o600); }
  catch { throw new Error('Test environment is locked. Stop dev:test before reset/restart. See TEST_ENVIRONMENT.md for stale-lock recovery.'); }
  writeFileSync(fd, `${process.pid}\n`);
  let released = false;
  return { ...paths, release() {
    if (released) return;
    released = true;
    closeSync(fd);
    unlinkSync(paths.lock);
  } };
}

export function prepareTestEnvironment(root: string, inherited: NodeJS.ProcessEnv = process.env, fixtureRoot = root) {
  const lock = acquireTestLock(root);
  try {
    const fixture = parse(readFileSync(join(fixtureRoot, '.env.test.example')));
    if (!fixture.TEST_ADMIN_PASSWORD) throw new Error('TEST_ADMIN_PASSWORD is required in .env.test.example.');
    const secretPath = join(lock.directory, 'session-secret');
    if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
    // Allow only OS plumbing. Never inherit provider, auth, VITE_*, dotenv or Node preload settings.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(inherited)) {
      if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|home|userprofile|localappdata|appdata)$/i.test(key)) env[key] = value;
    }
    Object.assign(env, {
      NODE_ENV: 'development', DATABASE_PATH: lock.database,
      ADMIN_PASSWORD_HASH: hashPassword(fixture.TEST_ADMIN_PASSWORD),
      SESSION_SECRET: readFileSync(secretPath, 'utf8'),
      PORT: '3000', APP_BASE_URL: 'http://127.0.0.1:5173',
      ACTIVE_CALL_STALE_SECONDS: '300', IMPORT_MAX_BYTES: '1048576', IMPORT_MAX_ROWS: '10000',
    });
    return { env, release: lock.release };
  } catch (error) { lock.release(); throw error; }
}

export function resetTestDatabase(root: string): void {
  const lock = acquireTestLock(root);
  try {
    // SQL reset, never unlink SQLite/WAL/SHM: active Unix handles cannot become orphan DBs.
    // SQLite handles journaling and refuses competing writers. The launcher lock excludes HMR too.
    const owner = new Database(lock.database);
    const db = owner.db;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const guards = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('audit_no_delete','audit_no_update')").all();
        db.exec('DROP TRIGGER audit_no_delete; DROP TRIGGER audit_no_update;');
        db.exec('DELETE FROM webhook_events; DELETE FROM call_attempts; DELETE FROM contacts; DELETE FROM phone_policy; DELETE FROM contact_audit_events;');
        for (const guard of guards) db.exec(String(guard.sql));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  } finally { lock.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'reset') throw new Error('Use npm run test:db:reset without arguments.');
    resetTestDatabase(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    console.log(testResetMessage);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
