import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { parseTarget } from '../index.js';

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
