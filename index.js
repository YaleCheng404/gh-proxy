const PREFIX = '/';
const MAX_REDIRECTS = 3;
const HEALTH_TEXT = 'GitHub Proxy is running securely.';
const FORBIDDEN_TEXT = 'Forbidden: Invalid resource target.';

const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS';
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'host',
  'origin',
  'referer',
  'transfer-encoding',
  'upgrade',
]);
const STRIPPED_RESPONSE_HEADERS = [
  'clear-site-data',
  'content-security-policy',
  'content-security-policy-report-only',
  'transfer-encoding',
];

const OWNER_REPO_PATH = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
const ALLOWED_TARGETS = [
  {
    hosts: ['github.com'],
    path: new RegExp(`^/${OWNER_REPO_PATH}/(?:releases|archive|blob|raw|info|git-|tags)(?:/|$)`, 'i'),
  },
  {
    hosts: ['raw.githubusercontent.com', 'raw.github.com'],
    path: new RegExp(`^/${OWNER_REPO_PATH}/.+`, 'i'),
  },
  {
    hosts: ['gist.githubusercontent.com', 'gist.github.com'],
    path: /^\/[A-Za-z0-9_.-]+\/.+/i,
  },
  {
    hosts: ['api.github.com', 'git.io', 'gitlab.com'],
    path: /^\/.+/i,
  },
];
const FOLLOW_REDIRECT_HOSTS = new Set([
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

export default {
  async fetch(request) {
    try {
      return await handleProxy(request);
    } catch (err) {
      console.error(JSON.stringify({
        message: 'proxy request failed',
        error: err instanceof Error ? err.message : String(err),
      }));
      return text('Proxy Error or Gateway Timeout', 502);
    }
  },
};

async function handleProxy(request) {
  const currentUrl = new URL(request.url);
  const queryTarget = currentUrl.searchParams.get('q');

  if (queryTarget) {
    return Response.redirect(`${currentUrl.origin}${PREFIX}${queryTarget}`, 301);
  }

  if (isPreflight(request)) {
    return preflightResponse(request);
  }

  const rawTarget = extractTarget(currentUrl);
  if (!rawTarget || rawTarget === '/') {
    return text(HEALTH_TEXT);
  }

  if (rawTarget === 'perl-pe-para') {
    return perlRewriteResponse(currentUrl.origin);
  }

  const targetUrl = parseTarget(rawTarget);
  if (!targetUrl || !isAllowedTarget(targetUrl)) {
    return text(FORBIDDEN_TEXT, 403);
  }

  if (targetUrl.hostname === 'github.com') {
    targetUrl.pathname = targetUrl.pathname.replace('/blob/', '/raw/');
  }

  return proxy(request, targetUrl, 0);
}

function extractTarget(currentUrl) {
  let target = currentUrl.href
    .slice(currentUrl.origin.length + PREFIX.length)
    .replace(/^https?:\/+/, 'https://');
  const nestedPrefix = `${currentUrl.origin}${PREFIX}`;

  while (target.startsWith(nestedPrefix)) {
    target = target.slice(nestedPrefix.length);
  }

  return target;
}

function parseTarget(rawTarget, baseUrl) {
  let target = rawTarget.trim();

  if (target.startsWith('git')) {
    target = `https://${target}`;
  } else if (!/^https?:\/\//i.test(target)) {
    target = `https://${target}`;
  }

  target = target.replace(/^https:\/(?!\/)/i, 'https://');

  try {
    const parsed = new URL(target, baseUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function isAllowedTarget(url) {
  const host = url.hostname.toLowerCase();
  return ALLOWED_TARGETS.some(({ hosts, path }) => (
    hosts.includes(host) && path.test(url.pathname)
  ));
}

function canFollowRedirect(url, method) {
  return ['GET', 'HEAD'].includes(method) && (
    isAllowedTarget(url) || FOLLOW_REDIRECT_HOSTS.has(url.hostname.toLowerCase())
  );
}

async function proxy(originalRequest, targetUrl, redirectCount) {
  const upstreamResponse = await fetch(targetUrl.href, buildUpstreamRequest(originalRequest));
  const responseHeaders = new Headers(upstreamResponse.headers);

  if (responseHeaders.has('location')) {
    const redirectUrl = parseRedirect(responseHeaders.get('location'), targetUrl.href);

    if (redirectUrl && isAllowedTarget(redirectUrl)) {
      responseHeaders.set('location', `${PREFIX}${redirectUrl.href}`);
    } else if (redirectUrl && redirectCount < MAX_REDIRECTS && canFollowRedirect(redirectUrl, originalRequest.method)) {
      return proxy(originalRequest, redirectUrl, redirectCount + 1);
    } else if (redirectUrl) {
      responseHeaders.set('location', redirectUrl.href);
    }
  }

  responseHeaders.set('access-control-expose-headers', '*');
  responseHeaders.set('access-control-allow-origin', '*');
  STRIPPED_RESPONSE_HEADERS.forEach(header => responseHeaders.delete(header));

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

function buildUpstreamRequest(request) {
  const headers = filterRequestHeaders(request.headers);
  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }

  return init;
}

function filterRequestHeaders(headers) {
  const cleanHeaders = new Headers();

  for (const [key, value] of headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      cleanHeaders.set(key, value);
    }
  }

  return cleanHeaders;
}

function parseRedirect(location, baseUrl) {
  try {
    return new URL(location, baseUrl);
  } catch {
    return null;
  }
}

function isPreflight(request) {
  return request.method === 'OPTIONS' && request.headers.has('access-control-request-headers');
}

function preflightResponse(request) {
  const requestedHeaders = request.headers.get('access-control-request-headers') || '*';

  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': ALLOWED_METHODS,
      'access-control-allow-headers': requestedHeaders,
      'access-control-max-age': '1728000',
    },
  });
}

function perlRewriteResponse(origin) {
  const perl = 'perl -pe';
  const script = [
    `s#(bash.*?\\.sh)([^/\\w\\d])#\\1 | ${perl} "\\$(curl -L ${origin}/perl-pe-para)" \\2#g`,
    's# (git)# https://\\1#g',
    `s#(http.*?git[^/]*?/)#${origin}/\\1#g`,
  ].join('; ');

  return text(script, 200, {
    'Cache-Control': 'max-age=300',
  });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...headers,
    },
  });
}
