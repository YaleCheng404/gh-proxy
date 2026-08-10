const MAX_REDIRECTS = 3;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const HEALTH_TEXT = 'GitHub Proxy is running securely.';
const FORBIDDEN_TEXT = 'Forbidden: Invalid resource target.';

const OWNER_REPO = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
const HOST_PATTERNS = [
  { host: 'github.com', path: new RegExp(`^/${OWNER_REPO}/(?:releases|archive|blob|raw|info|git-|tags)(?:/|$)`, 'i') },
  { host: 'raw.githubusercontent.com', path: new RegExp(`^/${OWNER_REPO}/.+`, 'i') },
  { host: 'raw.github.com', path: new RegExp(`^/${OWNER_REPO}/.+`, 'i') },
  { host: 'gist.githubusercontent.com', path: /^\/[A-Za-z0-9_.-]+\/.+/i },
  { host: 'gist.github.com', path: /^\/[A-Za-z0-9_.-]+\/.+/i },
  { host: 'api.github.com', path: /^\/.+/ },
  { host: 'git.io', path: /^\/.+/ },
  { host: 'gitlab.com', path: /^\/.+/ },
  { host: 'gitlab.net', path: /^\/.+/ },
  { host: '*.github.io', path: /^\/.+/ },
  { host: '*.gitlab.io', path: /^\/.+/ },
];
const REDIRECT_HOSTS = new Set([
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const REQUEST_HEADERS_TO_DROP = [
  'cf-connecting-ip',
  'cf-ipcountry',
  'connection',
  'cookie',
  'forwarded',
  'host',
  'origin',
  'proxy-authorization',
  'referer',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
];
const RESPONSE_HEADERS_TO_DROP = [
  'clear-site-data',
  'content-security-policy-report-only',
  'set-cookie',
  'transfer-encoding',
];
const RATE_LIMIT = {
  ipWindowMs: 60 * 1000,      // 1 minute
  ipMaxRequests: 10,          // per single IP
  globalWindowMs: 1000,       // 1 second
  globalMaxRequests: 5,       // all sources combined
  maxFileSize: 100 * 1024 * 1024, // 100 MiB
};
const perIpRequests = new Map();
let globalRequests = [];

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'proxy request failed',
        error: error instanceof Error ? error.message : String(error),
      }));
      return text('Proxy Error or Gateway Timeout', 502);
    }
  },
};

async function handle(request) {
  if (!allowRateLimit(clientIp(request))) {
    return text('Too Many Requests', 429, { 'retry-after': '1' });
  }
  if (isTooLarge(request.headers.get('content-length'))) {
    return text('Request Entity Too Large', 413);
  }

  const current = new URL(request.url);
  const queryTarget = current.searchParams.get('q');
  if (queryTarget) {
    return Response.redirect(`${current.origin}/${queryTarget.replace(/^\/+/, '')}`, 301);
  }

  if (isPreflight(request)) return preflight(request);

  const rawTarget = extractTarget(current);
  if (!rawTarget) return text(HEALTH_TEXT);
  if (rawTarget === 'perl-pe-para') return perlRewrite(current.origin);

  const target = parseTarget(rawTarget);
  if (!target || !isAllowed(target)) return text(FORBIDDEN_TEXT, 403);
  if (target.hostname === 'github.com') {
    target.pathname = target.pathname.replace('/blob/', '/raw/');
  }

  return proxy(request, target);
}

function extractTarget(current) {
  let target = current.href.slice(`${current.origin}/`.length);
  const ownUrls = [`${current.origin}/`, `${current.origin.replace('://', ':/')}/`];
  for (const ownUrl of ownUrls) {
    while (target.startsWith(ownUrl)) target = target.slice(ownUrl.length);
  }
  return target;
}

function parseTarget(rawTarget, base) {
  let target = rawTarget.trim();
  if (!target) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^https?:/i.test(target)) return null;

  if (base) {
    try {
      const url = new URL(target, base);
      if (url.protocol === 'http:') url.protocol = 'https:';
      return url.protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  }

  target = /^https?:/i.test(target)
    ? target.replace(/^https?:\/*/i, 'https://')
    : `https://${target}`;

  try {
    const url = new URL(target, base);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function hostMatches(host, pattern) {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

function isAllowed(url) {
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return HOST_PATTERNS.some(({ host: pat, path: regex }) =>
    hostMatches(host, pat) && regex.test(url.pathname)
  );
}

function canFollow(url, method) {
  return ['GET', 'HEAD'].includes(method) && (
    isAllowed(url) || (!url.port && REDIRECT_HOSTS.has(url.hostname.toLowerCase()))
  );
}

async function proxy(request, target, redirects = 0) {
  const upstream = await fetch(target.href, upstreamInit(request, redirects === 0));
  const headers = new Headers(upstream.headers);
  const location = headers.get('location');

  if (location) {
    const redirect = parseTarget(location, target.href);
    if (redirect && isAllowed(redirect)) {
      headers.set('location', `/${redirect.href}`);
    } else if (redirect && redirects < MAX_REDIRECTS && canFollow(redirect, request.method)) {
      await upstream.body?.cancel();
      return proxy(request, redirect, redirects + 1);
    } else if (redirect) {
      headers.set('location', redirect.href);
    }
  }

  if (isTooLarge(headers.get('content-length'))) {
    await upstream.body?.cancel();
    return text('Request Entity Too Large', 413);
  }

  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', '*');
  RESPONSE_HEADERS_TO_DROP.forEach(header => headers.delete(header));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function upstreamInit(request, forwardAuthorization) {
  const headers = new Headers(request.headers);
  REQUEST_HEADERS_TO_DROP.forEach(header => headers.delete(header));
  if (!forwardAuthorization) headers.delete('authorization');
  return {
    method: request.method,
    headers,
    redirect: 'manual',
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
  };
}

function isPreflight(request) {
  return request.method === 'OPTIONS' && request.headers.has('access-control-request-headers');
}

function preflight(request) {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': METHODS.join(','),
      'access-control-allow-headers': request.headers.get('access-control-request-headers') || '*',
      'access-control-max-age': '1728000',
    },
  });
}

function perlRewrite(origin) {
  return text([
    `s#(bash.*?\\.sh)([^/\\w\\d])#\\1 | perl -pe "\\$(curl -L ${origin}/perl-pe-para)" \\2#g`,
    's# (git)# https://\\1#g',
    `s#(http.*?git[^/]*?/)#${origin}/\\1#g`,
  ].join('; '), 200, { 'cache-control': 'max-age=300' });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}


function prune(timestamps, windowMs, now) {
  while (timestamps.length && timestamps[0] <= now - windowMs) timestamps.shift();
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

function allowRateLimit(ip, now = Date.now()) {
  prune(globalRequests, RATE_LIMIT.globalWindowMs, now);
  if (globalRequests.length >= RATE_LIMIT.globalMaxRequests) return false;

  let bucket = perIpRequests.get(ip);
  if (!bucket) {
    bucket = [];
    perIpRequests.set(ip, bucket);
  }
  prune(bucket, RATE_LIMIT.ipWindowMs, now);
  if (bucket.length >= RATE_LIMIT.ipMaxRequests) return false;

  globalRequests.push(now);
  bucket.push(now);
  return true;
}

function resetRateLimits() {
  perIpRequests.clear();
  globalRequests = [];
}

function isTooLarge(contentLength) {
  const n = Number(contentLength);
  return Number.isFinite(n) && n > RATE_LIMIT.maxFileSize;
}

export { extractTarget, isAllowed, parseTarget, allowRateLimit, resetRateLimits, clientIp, isTooLarge };
