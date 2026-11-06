import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from starlette.datastructures import Headers

from app.main import (
    allow_request,
    app,
    client_ip,
    is_allowed,
    is_too_large,
    parse_target,
    reset_rate_limits,
)


class TargetTests(unittest.TestCase):
    def test_normalizes_https_and_query(self):
        target = parse_target("http:/github.com/openai/openai/archive/main.zip", "download=1")
        self.assertEqual(str(target), "https://github.com/openai/openai/archive/main.zip?download=1")
        self.assertTrue(is_allowed(target))

    def test_rejects_other_schemes_and_ports(self):
        self.assertIsNone(parse_target("ftp://github.com/openai/openai/archive/main.zip"))
        self.assertFalse(is_allowed(httpx.URL("https://github.com:8443/openai/openai/archive/main.zip")))

    def test_rejects_non_allowlisted_paths(self):
        self.assertFalse(is_allowed(httpx.URL("https://github.com/openai/openai/issues")))
        self.assertFalse(is_allowed(httpx.URL("https://example.com/openai/openai/archive/main.zip")))

    def test_allows_github_and_gitlab_pages(self):
        self.assertTrue(is_allowed(httpx.URL("https://user.github.io/index.html")))
        self.assertTrue(is_allowed(httpx.URL("https://group.gitlab.io/project/index.html")))
        self.assertTrue(is_allowed(httpx.URL("https://gitlab.net/group/project/-/raw/main/README.md")))
        self.assertFalse(is_allowed(httpx.URL("https://example.io/file")))

    def test_git_smart_http_paths(self):
        for repo in ("repo", "repo.git"):
            for path in ("info/refs?service=git-upload-pack", "git-upload-pack", "git-receive-pack"):
                self.assertTrue(is_allowed(parse_target(f"github.com/user/{repo}/{path}")))
        self.assertFalse(is_allowed(parse_target("github.com/user/repo/git-arbitrary")))


class RateLimitTests(unittest.TestCase):
    def setUp(self):
        reset_rate_limits()

    def test_per_ip_limit_10_per_minute(self):
        now = 1_000_000.0
        for i in range(10):
            self.assertTrue(allow_request("1.2.3.4", now + i))
        self.assertFalse(allow_request("1.2.3.4", now + 10))
        self.assertTrue(allow_request("1.2.3.4", now + 60))

    def test_global_limit_5_per_second(self):
        now = 5_000_000.0
        for i in range(5):
            self.assertTrue(allow_request(f"10.0.0.{i}", now))
        self.assertFalse(allow_request("10.0.0.9", now))

    def test_is_too_large(self):
        self.assertFalse(is_too_large(str(100 * 1024 * 1024)))
        self.assertTrue(is_too_large(str(100 * 1024 * 1024 + 1)))
        self.assertFalse(is_too_large(None))
        for length in ("", "invalid", "-1", "1e100", "1.5"):
            self.assertFalse(is_too_large(length))

    def test_client_ip_prefers_x_forwarded_for(self):
        request = SimpleNamespace(headers=Headers({"x-forwarded-for": "203.0.113.1, 10.0.0.1"}), client=None)
        self.assertEqual(client_ip(request), "203.0.113.1")


class TrackedStream(httpx.AsyncByteStream):
    def __init__(self, content=b"data"):
        self.content = content
        self.closed = False

    async def __aiter__(self):
        yield self.content

    async def aclose(self):
        self.closed = True


class RouteTests(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        reset_rate_limits()
        self.requests = []
        self.streams = []
        self.respond = lambda request: httpx.Response(200, stream=self.new_stream())
        upstream = httpx.AsyncClient(transport=httpx.MockTransport(self.send))
        self.client = await self.enterAsyncContext(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver')
        )
        self.enterContext(patch('app.main.httpx.AsyncClient', return_value=upstream))
        await self.enterAsyncContext(app.router.lifespan_context(app))

    def new_stream(self, content=b'data'):
        stream = TrackedStream(content)
        self.streams.append(stream)
        return stream

    def send(self, request):
        self.requests.append(request)
        return self.respond(request)

    async def test_homepage_assets_and_health_do_not_use_quota(self):
        for _ in range(12):
            response = await self.client.get('/')
            self.assertEqual(response.status_code, 200)
            self.assertIn('GitHub Accelerator', response.text)
        self.assertEqual((await self.client.head('/')).content, b'')
        self.assertIn('<svg', (await self.client.get('/github.svg')).text)
        self.assertEqual((await self.client.get('/healthz')).text, 'GitHub Proxy is running.')
        self.assertEqual((await self.client.head('/healthz')).content, b'')
        self.assertEqual((await self.client.get('/https://api.github.com/user')).status_code, 200)

    async def test_query_redirect_stays_on_proxy_and_trims_input(self):
        response = await self.client.get('/', params={'q': '  //example.com/file  '}, follow_redirects=False)
        self.assertEqual(response.status_code, 301)
        self.assertEqual(response.headers['location'], 'http://testserver/example.com/file')
        self.assertEqual(self.requests, [])

    async def test_upstream_q_and_encoded_query_survive(self):
        response = await self.client.get('/https://api.github.com/search/code?q=a%2Bb&per_page=1')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(str(self.requests[0].url), 'https://api.github.com/search/code?q=a%2Bb&per_page=1')

    async def test_rejects_unknown_targets_and_ports(self):
        for path in ('unknown', 'https://example.com/file', 'https://github.com:8443/user/repo/archive/main.zip'):
            self.assertEqual((await self.client.get(f'/{path}')).status_code, 403)
        self.assertEqual(self.requests, [])

    async def test_rejects_retired_endpoint_and_nested_proxy_urls_before_fetching(self):
        for path in (
            '/perl-pe-para',
            '/http://testserver/https://api.github.com/user',
            '/http:/testserver/https://api.github.com/user',
        ):
            with self.subTest(path=path):
                self.assertEqual((await self.client.get(path)).status_code, 403)
        self.assertEqual(self.requests, [])

    async def test_blob_rewrite_and_header_filtering(self):
        response = await self.client.get('/http:/github.com/user/repo/blob/main/file', headers={'authorization': 'Bearer token', 'proxy-authorization': 'secret', 'cookie': 'private=1'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(str(self.requests[0].url), 'https://github.com/user/repo/raw/main/file')
        self.assertEqual(self.requests[0].headers['authorization'], 'Bearer token')
        self.assertNotIn('proxy-authorization', self.requests[0].headers)
        self.assertNotIn('cookie', self.requests[0].headers)
        self.assertTrue(self.streams[0].closed)

    async def test_post_body_and_range_response(self):
        self.respond = lambda request: httpx.Response(206, stream=self.new_stream(b'pack'), headers={'content-range': 'bytes 0-3/10', 'set-cookie': 'upstream=1'})
        response = await self.client.post('/https://github.com/user/repo.git/git-upload-pack', content=b'git packet', headers={'range': 'bytes=0-3'})
        self.assertEqual(self.requests[0].content, b'git packet')
        self.assertEqual(self.requests[0].headers['range'], 'bytes=0-3')
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, b'pack')
        self.assertEqual(response.headers['content-range'], 'bytes 0-3/10')
        self.assertEqual(response.headers['access-control-allow-origin'], '*')
        self.assertNotIn('set-cookie', response.headers)

    async def test_head_closes_upstream_without_body(self):
        self.respond = lambda request: httpx.Response(200, stream=self.new_stream(), headers={'content-length': '123'})
        response = await self.client.head('/https://raw.githubusercontent.com/user/repo/main/file')
        self.assertEqual(response.content, b'')
        self.assertEqual(response.headers['content-length'], '123')
        self.assertTrue(self.streams[0].closed)

    async def test_cors_preflight(self):
        response = await self.client.options('/https://api.github.com/user', headers={'access-control-request-headers': 'authorization,range'})
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers['access-control-allow-headers'], 'authorization,range')
        self.assertEqual(self.requests, [])

    async def test_rewrites_relative_redirect_to_allowlisted_resource(self):
        self.respond = lambda request: httpx.Response(
            302, stream=self.new_stream(), headers={'location': '../raw/main/file'}
        )
        response = await self.client.get('/https://github.com/user/repo/archive/main.zip')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers['location'], '/https://github.com/user/repo/raw/main/file')
        self.assertEqual(len(self.requests), 1)
        self.assertTrue(self.streams[0].closed)

    async def test_download_redirect_upgrades_http_drops_auth_and_closes_response(self):
        def respond(request):
            if len(self.requests) == 1:
                return httpx.Response(302, stream=self.new_stream(), headers={'location': 'http://codeload.github.com/user/repo/zip/main'})
            return httpx.Response(200, stream=self.new_stream(b'archive'))
        self.respond = respond
        response = await self.client.get(
            '/https://github.com/user/repo/archive/main.zip',
            headers={'authorization': 'Bearer token', 'proxy-authorization': 'secret'},
        )
        self.assertEqual(response.content, b'archive')
        self.assertEqual(str(self.requests[1].url), 'https://codeload.github.com/user/repo/zip/main')
        self.assertNotIn('authorization', self.requests[1].headers)
        self.assertNotIn('proxy-authorization', self.requests[1].headers)
        self.assertTrue(all(stream.closed for stream in self.streams))

    async def test_redirect_traversal_is_bounded(self):
        self.respond = lambda request: httpx.Response(302, stream=self.new_stream(), headers={'location': 'https://codeload.github.com/user/repo/zip/main'})
        response = await self.client.get('/https://github.com/user/repo/archive/main.zip', follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(len(self.requests), 4)
        self.assertTrue(all(stream.closed for stream in self.streams))

    async def test_upstream_failure_returns_502(self):

        def fail(request):
            raise httpx.ReadTimeout('timeout', request=request)
        self.respond = fail
        self.assertEqual((await self.client.get('/https://api.github.com/user')).status_code, 502)

    async def test_size_limits_close_upstream_and_reject_large_requests(self):
        self.respond = lambda request: httpx.Response(200, stream=self.new_stream(), headers={'content-length': '104857601'})
        self.assertEqual((await self.client.get('/https://api.github.com/user')).status_code, 413)
        self.assertTrue(self.streams[0].closed)
        self.assertEqual((await self.client.post('/https://api.github.com/user', headers={'content-length': '104857601'})).status_code, 413)

    async def test_proxy_quota_returns_429(self):
        for _ in range(5):
            self.assertEqual((await self.client.get('/https://api.github.com/user')).status_code, 200)
        self.assertEqual((await self.client.get('/https://api.github.com/user')).status_code, 429)


if __name__ == "__main__":
    unittest.main()
