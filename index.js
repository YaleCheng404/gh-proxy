const PREFIX = '/';
const MAX_REDIRECTS = 3;

// 严格的安全正则表达式
const VALID_PATTERNS = [
    /^(?:https?:\/\/)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/(?:releases|archive|blob|raw|info|git-|tags).*/i,
    /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/.+/i,
    /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/[a-zA-Z0-9_.-]+\/.+/i
];

export default {
    async fetch(request) {
        try {
            return await handleProxy(request);
        } catch (err) {
            return new Response("Proxy Error or Gateway Timeout", { status: 502 });
        }
    }
};

async function handleProxy(request) {
    const urlObj = new URL(request.url);
    let path = urlObj.searchParams.get('q');

    if (path) return Response.redirect('https://' + urlObj.host + PREFIX + path, 301);

    path = urlObj.href.slice(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://');
    if (!path || path === '/') return new Response("GitHub Proxy is running.", { status: 200 });

    if (!VALID_PATTERNS.some(pattern => pattern.test(path))) {
        return new Response("Forbidden: Invalid GitHub resource target.", { status: 403 });
    }

    if (/^(?:https?:\/\/)?github\.com\/.+?\/.+?\/blob\//i.test(path)) {
        path = path.replace('/blob/', '/raw/');
    }
    if (!path.startsWith('http')) path = 'https://' + path;

    const reqHeaders = new Headers(request.headers);
    if (request.method === 'OPTIONS' && reqHeaders.has('access-control-request-headers')) {
        return new Response(null, {
            status: 204,
            headers: {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
                'access-control-max-age': '1728000',
            }
        });
    }

    return executeProxy(new URL(path), {
        method: request.method,
        headers: reqHeaders,
        redirect: 'manual',
        body: request.body
    }, 0);
}

async function executeProxy(urlObj, reqInit, redirectCount) {
    const res = await fetch(urlObj.href, reqInit);
    const resHdrNew = new Headers(res.headers);

    if (resHdrNew.has('location') && redirectCount < MAX_REDIRECTS) {
        let loc = resHdrNew.get('location');
        if (VALID_PATTERNS.some(p => p.test(loc))) {
            resHdrNew.set('location', PREFIX + loc);
        } else {
            reqInit.redirect = 'manual';
            return executeProxy(new URL(loc), reqInit, redirectCount + 1);
        }
    }

    resHdrNew.set('access-control-expose-headers', '*');
    resHdrNew.set('access-control-allow-origin', '*');
    ['content-security-policy', 'content-security-policy-report-only', 'clear-site-data'].forEach(h => resHdrNew.delete(h));

    return new Response(res.body, { status: res.status, headers: resHdrNew });
}