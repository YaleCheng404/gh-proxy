import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import worker, { parseTarget, allowRateLimit, resetRateLimits } from '../index.js';

beforeEach(() => resetRateLimits());

test('returns health status at the root', async () => {
  const response = await worker.fetch(new Request('https://proxy.test/'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'GitHub Proxy is running securely.');
});

test('keeps query redirects on the proxy origin', async () => {
  const response = await worker.fetch(new Request('https://proxy.test/?q=//example.com/file'));
  assert.equal(response.headers.get('location'), 'https://proxy.test/example.com/file');
});

test('blocks non-allowlisted targets', async () => {
  const response = await worker.fetch(new Request('https://proxy.test/https://example.com/file'));
  assert.equal(response.status, 403);
});

test('resolves relative upstream redirects against their source URL', () => {
  const target = parseTarget('/openai/openai/archive/main.zip', 'https://github.com/source/repo');
  assert.equal(target.href, 'https://github.com/openai/openai/archive/main.zip');
});

test('upgrades HTTP, rewrites blob paths, and drops forwarding headers', async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, init) => {
    call = { url, init };
    return new Response('ok');
  };

  try {
    const request = new Request('https://proxy.test/http:/github.com/openai/openai/blob/main/README.md', {
      headers: {
        authorization: 'Bearer token',
        cookie: 'private=1',
        'proxy-authorization': 'Basic proxy-token',
        'x-forwarded-for': '127.0.0.1',
      },
    });
    const response = await worker.fetch(request);
    assert.equal(response.status, 200);
    assert.equal(call.url, 'https://github.com/openai/openai/raw/main/README.md');
    assert.equal(call.init.headers.get('authorization'), 'Bearer token');
    assert.equal(call.init.headers.has('cookie'), false);
    assert.equal(call.init.headers.has('proxy-authorization'), false);
    assert.equal(call.init.headers.has('x-forwarded-for'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('follows only known GitHub download redirect hosts', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/openai/openai/zip/main' } })
      : new Response('archive');
  };

  try {
    const response = await worker.fetch(new Request(
      'https://proxy.test/https://github.com/openai/openai/archive/main.zip',
      { headers: {
        authorization: 'Bearer token',
        'proxy-authorization': 'Basic proxy-token',
      } },
    ));
    assert.equal(await response.text(), 'archive');
    assert.equal(calls[0].url, 'https://github.com/openai/openai/archive/main.zip');
    assert.equal(calls[0].headers.get('authorization'), 'Bearer token');
    assert.equal(calls[0].headers.has('proxy-authorization'), false);
    assert.equal(calls[1].url, 'https://codeload.github.com/openai/openai/zip/main');
    assert.equal(calls[1].headers.has('authorization'), false);
    assert.equal(calls[1].headers.has('proxy-authorization'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('proxies GitHub Pages and GitLab Pages subdomains plus gitlab.net', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    return new Response('ok');
  };

  try {
    const cases = [
      'https://proxy.test/https://user.github.io/index.html',
      'https://proxy.test/https://group.gitlab.io/project/index.html',
      'https://proxy.test/https://gitlab.net/group/project/-/raw/main/README.md',
    ];
    for (const url of cases) {
      const response = await worker.fetch(new Request(url));
      assert.equal(response.status, 200, url);
    }
    assert.equal(calls[0], 'https://user.github.io/index.html');
    assert.equal(calls[1], 'https://group.gitlab.io/project/index.html');
    assert.equal(calls[2], 'https://gitlab.net/group/project/-/raw/main/README.md');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rate limits a single IP to 10 requests per minute', () => {
  resetRateLimits();
  const base = 1_000_000;
  for (let i = 0; i < 10; i++) {
    assert.equal(allowRateLimit('1.2.3.4', base + i * 1000), true);
  }
  assert.equal(allowRateLimit('1.2.3.4', base + 10 * 1000), false);
  assert.equal(allowRateLimit('1.2.3.4', base + 61 * 1000), true);
});

test('rate limits all sources to 5 requests per second', () => {
  resetRateLimits();
  const now = 5_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(allowRateLimit(`10.0.0.${i}`, now), true);
  }
  assert.equal(allowRateLimit('10.0.0.9', now), false);
});

test('rejects requests with content-length over 100MB', async () => {
  const big = String(100 * 1024 * 1024 + 1);
  const response = await worker.fetch(new Request(
    'https://proxy.test/https://github.com/openai/openai/archive/main.zip',
    { method: 'POST', headers: { 'content-length': big } },
  ));
  assert.equal(response.status, 413);
});

test('rejects upstream responses with content-length over 100MB', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('x', {
    status: 200,
    headers: { 'content-length': String(100 * 1024 * 1024 + 1) },
  });
  try {
    const response = await worker.fetch(new Request(
      'https://proxy.test/https://github.com/openai/openai/archive/main.zip',
    ));
    assert.equal(response.status, 413);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

