const MAX_REDIRECTS = 3;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const HEALTH_TEXT = 'GitHub Proxy is running securely.';
const FORBIDDEN_TEXT = 'Forbidden: Invalid resource target.';

const OWNER_REPO = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
const TARGET_PATHS = new Map([
  ['github.com', new RegExp(`^/${OWNER_REPO}/(?:releases|archive|blob|raw|info|git-|tags)(?:/|$)`, 'i')],
  ['raw.githubusercontent.com', new RegExp(`^/${OWNER_REPO}/.+`, 'i')],
  ['raw.github.com', new RegExp(`^/${OWNER_REPO}/.+`, 'i')],
  ['gist.githubusercontent.com', /^\/[A-Za-z0-9_.-]+\/.+/i],
  ['gist.github.com', /^\/[A-Za-z0-9_.-]+\/.+/i],
  ['api.github.com', /^\/.+/],
  ['git.io', /^\/.+/],
  ['gitlab.com', /^\/.+/],
]);
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

function isAllowed(url) {
  if (url.port && url.port !== '443') return false;
  return TARGET_PATHS.get(url.hostname.toLowerCase())?.test(url.pathname) === true;
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

export { extractTarget, isAllowed, parseTarget };
