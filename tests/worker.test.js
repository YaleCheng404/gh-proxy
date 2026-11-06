import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';

import worker, { isAllowed, isTooLarge, parseTarget, allowRateLimit, resetRateLimits } from '../index.js';

beforeEach(() => resetRateLimits());

test('serves the shared homepage and assets without using proxy quota', async () => {
  const env = { ASSETS: { async fetch(request) {
    const file = new URL(request.url).pathname.slice(1);
    return new Response(request.method === 'HEAD' ? null : await readFile(new URL(`../public/${file}`, import.meta.url)), {
      headers: { 'content-type': file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' },
    });
  } } };
  for (let i = 0; i < 12; i++) {
    const response = await worker.fetch(new Request('https://proxy.test/'), env);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /GitHub Accelerator/);
  }
  assert.equal(await (await worker.fetch(new Request('https://proxy.test/', { method: 'HEAD' }), env)).text(), '');
  assert.match(await (await worker.fetch(new Request('https://proxy.test/github.svg'), env)).text(), /<svg/);
  assert.equal(allowRateLimit('unknown'), true);
});

test('returns a separate health status', async () => {
  const response = await worker.fetch(new Request('https://proxy.test/healthz'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'GitHub Proxy is running.');
  assert.equal(await (await worker.fetch(new Request('https://proxy.test/healthz', { method: 'HEAD' }))).text(), '');
});

test('keeps query redirects on the proxy origin', async () => {
  const response = await worker.fetch(new Request('https://proxy.test/?q=//example.com/file'));
  assert.equal(response.headers.get('location'), 'https://proxy.test/example.com/file');
});

test('blocks non-allowlisted targets', async () => {
  const response = await worker.fetch(new Request('https://proxy.test/https://example.com/file'));
  assert.equal(response.status, 403);
});

test('rejects the retired endpoint and nested proxy URLs before fetching', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('unexpected'));
  for (const path of [
    '/perl-pe-para',
    '/https://proxy.test/https://api.github.com/user',
    '/https:/proxy.test/https://api.github.com/user',
  ]) {
    const response = await worker.fetch(new Request('https://proxy.test' + path));
    assert.equal(response.status, 403, path);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rewrites relative redirects to allowlisted resources without fetching them', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302,
    headers: { location: '../raw/main/file' },
  }));
  const response = await worker.fetch(new Request('https://proxy.test/https://github.com/user/repo/archive/main.zip'));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/https://github.com/user/repo/raw/main/file');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('upgrades HTTP, rewrites blob paths, and drops forwarding headers', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const request = new Request('https://proxy.test/http:/github.com/openai/openai/blob/main/README.md', {
    headers: {
      authorization: 'Bearer token',
      cookie: 'private=1',
      'proxy-authorization': 'Basic proxy-token',
      'x-forwarded-for': '127.0.0.1',
    },
  });
  assert.equal((await worker.fetch(request)).status, 200);
  const [url, { headers }] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, 'https://github.com/openai/openai/raw/main/README.md');
  assert.equal(headers.get('authorization'), 'Bearer token');
  assert.equal(headers.has('cookie'), false);
  assert.equal(headers.has('proxy-authorization'), false);
  assert.equal(headers.has('x-forwarded-for'), false);
});

test('follows a GitHub download redirect without forwarding credentials', async t => {
  const archive = 'https://github.com/openai/openai/archive/main.zip';
  const download = 'https://codeload.github.com/openai/openai/zip/main';
  const fetchMock = t.mock.method(globalThis, 'fetch', async url => url === archive
    ? new Response(null, { status: 302, headers: { location: download } })
    : new Response('archive'));
  const response = await worker.fetch(new Request('https://proxy.test/' + archive, {
    headers: { authorization: 'Bearer token', 'proxy-authorization': 'Basic proxy-token' },
  }));
  assert.equal(await response.text(), 'archive');
  assert.equal(fetchMock.mock.callCount(), 2);
  const [[firstUrl, first], [secondUrl, second]] = fetchMock.mock.calls.map(call => call.arguments);
  assert.equal(firstUrl, archive);
  assert.equal(first.headers.get('authorization'), 'Bearer token');
  assert.equal(first.headers.has('proxy-authorization'), false);
  assert.equal(secondUrl, download);
  assert.equal(second.headers.has('authorization'), false);
  assert.equal(second.headers.has('proxy-authorization'), false);
});

test('proxies GitHub Pages and GitLab Pages subdomains plus gitlab.net', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const targets = [
    'https://user.github.io/index.html',
    'https://group.gitlab.io/project/index.html',
    'https://gitlab.net/group/project/-/raw/main/README.md',
  ];
  for (const target of targets) {
    const response = await worker.fetch(new Request('https://proxy.test/' + target));
    assert.equal(response.status, 200, target);
  }
  assert.deepEqual(fetchMock.mock.calls.map(call => call.arguments[0]), targets);
});

test('rate limits a single IP to 10 requests per minute', () => {
  const base = 1_000_000;
  for (let i = 0; i < 10; i++) {
    assert.equal(allowRateLimit('1.2.3.4', base + i * 1000), true);
  }
  assert.equal(allowRateLimit('1.2.3.4', base + 10 * 1000), false);
  assert.equal(allowRateLimit('1.2.3.4', base + 61 * 1000), true);
});

test('rate limits all sources to 5 requests per second', () => {
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

test('preserves upstream q parameters and encoded query values', async t => {
  let target;
  t.mock.method(globalThis, 'fetch', async url => { target = url; return new Response('results'); });
  const response = await worker.fetch(new Request('https://proxy.test/https://api.github.com/search/code?q=a%2Bb&per_page=1'));
  assert.equal(await response.text(), 'results');
  assert.equal(target, 'https://api.github.com/search/code?q=a%2Bb&per_page=1');
});

test('allows Git smart HTTP endpoints with or without .git', () => {
  for (const repo of ['repo', 'repo.git']) {
    for (const path of ['info/refs?service=git-upload-pack', 'git-upload-pack', 'git-receive-pack']) {
      assert.equal(isAllowed(parseTarget(`github.com/user/${repo}/${path}`)), true);
    }
  }
  assert.equal(isAllowed(parseTarget('github.com/user/repo/git-arbitrary')), false);
  assert.equal(isAllowed(parseTarget('https://github.com:8443/user/repo/archive/main.zip')), false);
  assert.equal(parseTarget('ftp://github.com/user/repo/archive/main.zip'), null);
});

test('forwards Git POST bodies and Range responses', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(await new Response(init.body).text(), 'git packet');
    assert.equal(init.headers.get('range'), 'bytes=0-3');
    return new Response('pack', { status: 206, headers: { 'content-range': 'bytes 0-3/10', 'set-cookie': 'upstream=1' } });
  });
  const response = await worker.fetch(new Request('https://proxy.test/https://github.com/user/repo.git/git-upload-pack', {
    method: 'POST', body: 'git packet', headers: { range: 'bytes=0-3' },
  }));
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'pack');
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/10');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.has('set-cookie'), false);
});

test('handles HEAD and CORS preflight', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'HEAD');
    return new Response(null, { headers: { 'content-length': '123' } });
  });
  const head = await worker.fetch(new Request('https://proxy.test/https://raw.githubusercontent.com/user/repo/main/file', { method: 'HEAD' }));
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), '123');
  const preflight = await worker.fetch(new Request('https://proxy.test/https://api.github.com/user', {
    method: 'OPTIONS', headers: { 'access-control-request-headers': 'authorization,range' },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization,range');
});

test('bounds download redirects and cancels discarded streams', async t => {
  let calls = 0;
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: 302, headers: { location: 'https://codeload.github.com/user/repo/zip/main' },
    });
  });
  const response = await worker.fetch(new Request('https://proxy.test/https://github.com/user/repo/archive/main.zip'));
  assert.equal(calls, 4);
  assert.equal(cancelled, 3);
  assert.equal(response.status, 302);
  await response.body.cancel();
});

test('does not fetch arbitrary upstream redirect hosts', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302, headers: { location: 'https://example.com/file' },
  }));
  const response = await worker.fetch(new Request('https://proxy.test/https://github.com/user/repo/archive/main.zip'));
  assert.equal(mock.mock.callCount(), 1);
  assert.equal(response.headers.get('location'), 'https://example.com/file');
});

test('returns 502 on upstream failure', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('timeout'); });
  assert.equal((await worker.fetch(new Request('https://proxy.test/https://api.github.com/user'))).status, 502);
});

test('cancels oversized upstream streams', async t => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: { 'content-length': '104857601' } }));
  assert.equal((await worker.fetch(new Request('https://proxy.test/https://api.github.com/user'))).status, 413);
  assert.equal(cancelled, true);
});

test('accepts the size boundary and ignores malformed lengths', () => {
  assert.equal(isTooLarge('104857600'), false);
  assert.equal(isTooLarge('104857601'), true);
  for (const length of [null, '', 'invalid', '-1', '1e100', '1.5']) assert.equal(isTooLarge(length), false);
});

