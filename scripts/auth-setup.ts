import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents, type Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { parse } from 'dotenv';
import { hashPassword } from '../src/middleware/auth.ts';

class SetupError extends Error {}

export function promptPassword(
  label: string,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new SetupError('An interactive terminal is required; piped passwords are not accepted.'));
  }
  return new Promise((resolvePassword, reject) => {
    const wasRaw = input.isRaw;
    const wasFlowing = input.readableFlowing === true;
    let value = '';
    const finish = (error?: Error) => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onCancel);
      input.removeListener('close', onCancel);
      input.removeListener('error', onCancel);
      process.removeListener('SIGINT', onCancel);
      process.removeListener('SIGTERM', onCancel);
      try {
        input.setRawMode(wasRaw);
        if (!wasFlowing) input.pause();
        output.write('\n');
      } catch {
        error = new SetupError('Could not restore the terminal. No password was saved.');
      }
      const result = value;
      value = '';
      if (error) reject(error);
      else resolvePassword(result);
    };
    const onCancel = () => finish(new SetupError('Password setup cancelled. No changes were made.'));
    const onKey = (text: string | undefined, key: Key) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) onCancel();
      else if (key.name === 'return' || key.name === 'enter') finish();
      else if (key.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f\x1b]/.test(text)) value += text;
    };
    emitKeypressEvents(input);
    input.on('keypress', onKey);
    input.once('end', onCancel);
    input.once('close', onCancel);
    input.once('error', onCancel);
    process.once('SIGINT', onCancel);
    process.once('SIGTERM', onCancel);
    try {
      input.setRawMode(true);
      output.write(label);
      input.resume();
    } catch {
      finish(new SetupError('Could not read securely from the terminal. No changes were made.'));
    }
  });
}

export function updatePasswordHash(source: string, hash: string): string {
  // Match complete dotenv values (including quoted multiline values), not comments.
  const assignment = /^([\t ]*(?:export[\t ]+)?)([\w.-]+)([\t ]*=[\t ]*|:[\t ]+)(?:"(?:\\"|[^"])*"|'[^']*'|`[^`]*`|[^#\r\n]*?)([\t ]*(?:#[^\r\n]*)?)(?=\r?$)/gm;
  let found = false;
  const updated = source.replace(assignment, (match, prefix: string, key: string, separator: string, suffix: string) => {
    if (key !== 'ADMIN_PASSWORD_HASH') return match;
    found = true;
    return `${prefix}${key}${separator}'${hash}'${suffix}`;
  });
  if (found) return updated;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return `${source}${source && !source.endsWith('\n') ? newline : ''}ADMIN_PASSWORD_HASH='${hash}'${newline}`;
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function setupPassword(
  root: string,
  prompt: (label: string) => Promise<string> = promptPassword,
  output: (message: string) => void = console.log,
): Promise<void> {
  let password = await prompt('New admin password (hidden): ');
  let confirmation = await prompt('Confirm admin password (hidden): ');
  if (!password || password !== confirmation) {
    throw new SetupError('Passwords must be non-empty and match. No changes were made.');
  }
  const hash = hashPassword(password);
  password = confirmation = '';
  const envPath = resolve(root, '.env');
  const existing = readOptional(envPath);
  const source = existing ?? readOptional(resolve(root, '.env.example')) ?? '';
  const updated = updatePasswordHash(source, hash);
  if (parse(updated).ADMIN_PASSWORD_HASH !== hash) {
    throw new SetupError('Could not safely update ADMIN_PASSWORD_HASH. No changes were made.');
  }
  if (existing === undefined) {
    // Never overwrite a file created by another process during setup.
    writeFileSync(envPath, updated, { flag: 'wx', mode: 0o600 });
  } else {
    const temporary = `${envPath}.auth-setup-${process.pid}.tmp`;
    let created = false;
    try {
      writeFileSync(temporary, updated, { flag: 'wx', mode: statSync(envPath).mode & 0o777 });
      created = true;
      if (readFileSync(envPath, 'utf8') !== existing) {
        throw new SetupError('.env changed during setup. Nothing was overwritten; please retry.');
      }
      renameSync(temporary, envPath);
    } finally {
      if (created && existsSync(temporary)) unlinkSync(temporary);
    }
  }
  output('Admin password saved. Restart the backend to apply the change.');
  if (!parse(updated).SESSION_SECRET?.trim()) {
    output('SESSION_SECRET is missing or empty. Configure it separately before using authentication; it was not changed.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('Run npm run auth:setup without arguments. Enter the password only at the hidden prompts.');
    process.exitCode = 1;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    setupPassword(root).catch((error: unknown) => {
      console.error(error instanceof SetupError ? error.message : 'Password setup failed. Check file permissions and retry.');
      process.exitCode = 1;
    });
  }
}
