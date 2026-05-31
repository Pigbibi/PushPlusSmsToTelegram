const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function loadState(file) {
  if (!fs.existsSync(file)) return { forwarded: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.forwarded)) return { forwarded: [] };
    return parsed;
  } catch {
    return { forwarded: [] };
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const forwarded = Array.from(new Map((state.forwarded || []).map(item => [item.id, item])).values())
    .sort((a, b) => String(a.forwardedAt || '').localeCompare(String(b.forwardedAt || '')))
    .slice(-1000);
  fs.writeFileSync(file, `${JSON.stringify({ forwarded }, null, 2)}\n`, { mode: 0o600 });
}

function messageId(message, secret) {
  if (!secret) throw new Error('Missing STATE_SECRET. Use a random secret so public state files do not expose PushPlus shortCode values.');
  return crypto.createHmac('sha256', secret)
    .update(String(message.shortCode || ''))
    .digest('hex');
}

function hasForwarded(state, id) {
  return new Set((state.forwarded || []).map(item => item.id)).has(id);
}

function markForwarded(state, id) {
  state.forwarded = state.forwarded || [];
  if (!hasForwarded(state, id)) {
    state.forwarded.push({ id, forwardedAt: new Date().toISOString() });
  }
}

module.exports = {
  hasForwarded,
  loadState,
  markForwarded,
  messageId,
  saveState,
};
