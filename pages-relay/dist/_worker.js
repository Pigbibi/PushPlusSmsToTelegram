const DEFAULT_WORKER_ORIGIN = 'https://pushplus-sms-to-telegram.pigbibi.workers.dev';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requestToken(request, url) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const prefix = '/pushplus/webhook/';
  if (url.pathname.startsWith(prefix)) return decodeURIComponent(url.pathname.slice(prefix.length));
  return url.searchParams.get('token') || '';
}

function relayHeaders(request) {
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'user-agent']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return jsonResponse({ code: 200, msg: 'ok' });
    if (url.pathname !== '/pushplus/webhook' && !url.pathname.startsWith('/pushplus/webhook/')) {
      return jsonResponse({ code: 404, msg: 'not found' }, 404);
    }

    const token = requestToken(request, url);
    if (!env.RELAY_TOKEN || token !== env.RELAY_TOKEN) {
      return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
    }

    const workerOrigin = env.WORKER_ORIGIN || DEFAULT_WORKER_ORIGIN;
    const target = new URL(`/pushplus/webhook/${encodeURIComponent(token)}`, workerOrigin);
    const upstream = await fetch(target, {
      method: request.method,
      headers: relayHeaders(request),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    });
  },
};
