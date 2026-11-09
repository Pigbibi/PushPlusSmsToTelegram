// KV stand-ins and the one derivation of the dedupe key shape, so a mock that
// answers a specific `sourceId` cannot drift away from the Worker's writer.
import { webcrypto } from 'node:crypto';

export function memoryKv() {
  const stored = new Map();
  return {
    stored,
    binding: {
      get: async key => stored.get(key) || null,
      put: async (key, value) => stored.set(key, value),
    },
  };
}

export async function workerDedupeKey(secret, sourceId) {
  const input = new TextEncoder().encode(`${secret}:${sourceId}`);
  const digest = await webcrypto.subtle.digest('SHA-256', input);
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `pushplus:${hex}`;
}
