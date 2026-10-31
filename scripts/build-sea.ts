import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createWriteStream } from 'node:fs';
import { get } from 'node:https';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = join(root, 'dist');
const nodeVersion = '24.18.0';
const cacheDir = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || root, 'AppData', 'Local'), 'ip2', 'node-cache');
const nodeZip = join(cacheDir, `node-v${nodeVersion}-win-x64.zip`);
const nodeExtracted = join(cacheDir, `node-v${nodeVersion}-win-x64`);
const nodeExe = join(nodeExtracted, 'node.exe');

const targetExe = join(dist, 'sequential-retell-dashboard.exe');
const seaConfigPath = join(dist, 'sea-config.json');
const blobPath = join(dist, 'sea-prep.blob');

function log(...args: unknown[]) {
  console.log('[SEA]', ...args);
}

function exec(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function downloadNode(): Promise<void> {
  if (existsSync(nodeExe)) {
    log('Using cached Node binary', nodeExe);
    return;
  }
  mkdirSync(cacheDir, { recursive: true });
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const zipName = `node-v${nodeVersion}-win-x64.zip`;
  const url = `${baseUrl}/${zipName}`;
  if (!existsSync(nodeZip)) {
    log('Downloading Node', url);
    await downloadFile(url, nodeZip);
  }
  log('Verifying Node archive hash');
  await verifyArchiveHash(zipName);
  log('Extracting Node archive');
  await exec('powershell', ['-Command', `Expand-Archive -Path '${nodeZip}' -DestinationPath '${cacheDir}' -Force`]);
  if (!existsSync(nodeExe)) {
    throw new Error(`Node extraction failed; expected ${nodeExe}`);
  }
  log('Node binary ready', nodeExe);
}

async function verifyArchiveHash(zipName: string): Promise<void> {
  const shasumsUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
  const shasumsPath = join(cacheDir, 'SHASUMS256.txt');
  if (!existsSync(shasumsPath)) {
    await downloadFile(shasumsUrl, shasumsPath);
  }
  const shasums = readFileSync(shasumsPath, 'utf8');
  const expectedLine = shasums.split('\n').find((line) => line.endsWith(zipName));
  if (!expectedLine) {
    throw new Error(`Hash entry not found for ${zipName}`);
  }
  const expectedHash = expectedLine.split(' ')[0];
  const actualHash = sha256File(nodeZip);
  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error(`Hash mismatch for ${zipName}: expected ${expectedHash}, got ${actualHash}`);
  }
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect without location'));
        downloadFile(loc, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', reject);
  });
}

function collectAssets(dir: string, prefix: string): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const key = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      Object.assign(assets, collectAssets(full, key));
    } else {
      assets[key] = full;
    }
  }
  return assets;
}

function buildSeaConfig(): void {
  const frontendDir = join(dist, 'frontend');
  if (!existsSync(frontendDir)) {
    throw new Error('Frontend build not found; run npm run build:frontend first');
  }
  const assets = collectAssets(frontendDir, '');
  const config = {
    main: resolve(dist, 'server.cjs').replace(/\\/g, '/'),
    output: blobPath.replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets,
  };
  writeFileSync(seaConfigPath, JSON.stringify(config, null, 2));
  log('Wrote', seaConfigPath);
}

async function main() {
  mkdirSync(dist, { recursive: true });

  log('Building backend');
  await exec('npm', ['run', 'build:backend'], root);

  log('Building frontend');
  await exec('npm', ['run', 'build:frontend'], root);

  log('Downloading/caching Node binary', nodeVersion);
  await downloadNode();

  log('Generating SEA config');
  buildSeaConfig();

  log('Generating SEA blob');
  await exec(nodeExe, ['--experimental-sea-config', seaConfigPath], root);

  log('Copying Node binary to target');
  copyFileSync(nodeExe, targetExe);

  log('Injecting SEA blob');
  await exec(
    'npx',
    [
      'postject',
      targetExe,
      'NODE_SEA_BLOB',
      blobPath,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      '--macho-segment-name',
      'NODE_SEA',
    ],
    root,
  );

  log('SEA executable built:', targetExe);
  const stat = statSync(targetExe);
  log('Size:', stat.size, 'bytes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
