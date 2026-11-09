import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function validateState(text) {
  const value = JSON.parse(text);
  if (!value || !Array.isArray(value.forwarded) || value.forwarded.some(item =>
    !item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id)
      || typeof item.forwardedAt !== 'string' || !Number.isFinite(Date.parse(item.forwardedAt)))) {
    throw new Error('Invalid private forwarded state; forwarding stopped.');
  }
  return { forwarded: value.forwarded.map(({ id, forwardedAt }) => ({ id, forwardedAt })) };
}

function syncState(mode, { env = process.env, runStorage = args => execFileSync('gcloud',
  ['storage', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const bucket = env.PRIVATE_STATE_BUCKET || '';
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) {
    throw new Error('Configure PRIVATE_STATE_BUCKET before forwarding.');
  }
  const uri = `gs://${bucket}/PushPlusSmsToTelegram/forwarded.json`;
  const file = env.STATE_FILE || '.state/forwarded.json';
  const generationFile = `${file}.generation`;
  if (mode === 'restore') {
    const generation = runStorage(['objects', 'describe', uri, '--format=value(generation)']).trim();
    if (!/^\d+$/.test(generation)) throw new Error('Private state generation unavailable.');
    // Pin the read to the described version to prevent stale-data/new-generation races.
    const state = validateState(runStorage(['cat', `${uri}#${generation}`]));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    fs.writeFileSync(generationFile, generation, { mode: 0o600 });
  } else if (mode === 'persist') {
    const generation = fs.readFileSync(generationFile, 'utf8').trim();
    if (!/^\d+$/.test(generation)) throw new Error('Private state generation unavailable.');
    const state = validateState(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    runStorage(['cp', file, uri, `--if-generation-match=${generation}`]);
  } else throw new Error('Use restore or persist.');
}

// This package is ESM ("type": "module"), so require.main === module is not
// available. Compare real paths so symlinked working directories still match.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try { syncState(process.argv[2]); } catch {
    console.error('Private state unavailable or invalid; forwarding stopped.');
    process.exitCode = 1;
  }
}

export { syncState, validateState };
