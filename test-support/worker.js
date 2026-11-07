const workerUrl = new URL('../worker.js', import.meta.url);
let loadCount = 0;

export function memoryDurableObjects(Coordinator, env) {
  const stores = new Map();
  const instances = new Map();
  function storageFor(name) {
    if (stores.has(name)) return stores.get(name);
    const data = new Map();
    let tail = Promise.resolve();
    const view = values => ({
      get: async key => structuredClone(values.get(key)),
      put: async (key, value) => { values.set(key, structuredClone(value)); },
      delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
      list: async ({ prefix = '' } = {}) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
    });
    const storage = {
      ...view(data), data, failTransactions: false,
      transaction(callback) {
        const result = tail.then(async () => {
          if (storage.failTransactions) throw new Error('synthetic storage unavailable');
          const draft = new Map([...data].map(([key, value]) => [key, structuredClone(value)]));
          const result = await callback(view(draft));
          data.clear();
          for (const [key, value] of draft) data.set(key, value);
          return result;
        });
        tail = result.catch(() => {});
        return result;
      },
    };
    stores.set(name, storage);
    return storage;
  }
  return {
    storageFor,
    rebuild(name) { instances.delete(name); },
    getByName(name) {
      return {
        fetch(request) {
          if (!instances.has(name)) instances.set(name, new Coordinator({ storage: storageFor(name) }, env));
          return instances.get(name).fetch(typeof request === 'string' ? new Request(request) : request);
        },
      };
    },
  };
}

// Each load gets a fresh module instance, so the Worker's module-level caches
// (PushPlus access key, HMAC key, inbox snapshot) cannot leak between tests.
export async function loadWorker({ withCoordinator = true } = {}) {
  loadCount += 1;
  const instanceUrl = new URL(workerUrl);
  instanceUrl.searchParams.set('load', String(loadCount));
  const module = await import(instanceUrl.href);
  if (!withCoordinator) return module;
  const bindings = new WeakMap();
  function prepared(env) {
    if (env.INTERCEPT_LEASES || !env.FORWARDED_KV) return env;
    if (!bindings.has(env.FORWARDED_KV)) bindings.set(env.FORWARDED_KV, memoryDurableObjects(module.InterceptLeaseCoordinator, env));
    return { ...env, INTERCEPT_LEASES: bindings.get(env.FORWARDED_KV) };
  }
  return {
    ...module,
    default: {
      fetch: (request, env, ctx) => module.default.fetch(request, prepared(env), ctx),
      scheduled: (event, env, ctx) => module.default.scheduled(event, prepared(env), ctx),
    },
  };
}
