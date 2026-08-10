import unittest
from types import SimpleNamespace

import httpx
from starlette.datastructures import Headers

from app.main import (
    allow_request,
    client_ip,
    is_allowed,
    is_too_large,
    parse_redirect,
    parse_target,
    reset_rate_limits,
    send_upstream,
    strip_nested_proxy,
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

    def test_strips_nested_proxy_urls(self):
        self.assertEqual(
            strip_nested_proxy(
                "https://proxy.test/https://github.com/openai/openai/archive/main.zip",
                "https://proxy.test",
            ),
            "https://github.com/openai/openai/archive/main.zip",
        )

    def test_resolves_and_upgrades_redirects(self):
        target = parse_redirect("http://codeload.github.com/openai/openai/zip/main", "https://github.com/")
        self.assertEqual(str(target), "https://codeload.github.com/openai/openai/zip/main")


class HeaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_drops_proxy_auth_and_cross_host_authorization(self):
        class Client:
            def build_request(self, method, target, headers, content):
                self.headers = headers
                return httpx.Request(method, target, headers=headers)

            async def send(self, request, stream):
                return httpx.Response(200, request=request)

        client = Client()
        request = SimpleNamespace(
            method="GET",
            headers=Headers({
                "authorization": "Bearer token",
                "proxy-authorization": "Basic proxy-token",
            }),
            app=SimpleNamespace(state=SimpleNamespace(client=client)),
        )
        await send_upstream(request, httpx.URL("https://objects.githubusercontent.com/file"), False)
        self.assertNotIn("authorization", client.headers)
        self.assertNotIn("proxy-authorization", client.headers)

class RateLimitTests(unittest.TestCase):
    def setUp(self):
        reset_rate_limits()

    def test_per_ip_limit_10_per_minute(self):
        now = 1_000_000.0
        for i in range(10):
            self.assertTrue(allow_request("1.2.3.4", now + i * 1000))
        self.assertFalse(allow_request("1.2.3.4", now + 10 * 1000))
        self.assertTrue(allow_request("1.2.3.4", now + 61 * 1000))

    def test_global_limit_5_per_second(self):
        now = 5_000_000.0
        for i in range(5):
            self.assertTrue(allow_request(f"10.0.0.{i}", now))
        self.assertFalse(allow_request("10.0.0.9", now))

    def test_is_too_large(self):
        self.assertFalse(is_too_large(str(100 * 1024 * 1024)))
        self.assertTrue(is_too_large(str(100 * 1024 * 1024 + 1)))
        self.assertFalse(is_too_large(None))

    def test_client_ip_prefers_x_forwarded_for(self):
        request = SimpleNamespace(headers=Headers({"x-forwarded-for": "203.0.113.1, 10.0.0.1"}), client=None)
        self.assertEqual(client_ip(request), "203.0.113.1")


if __name__ == "__main__":
    unittest.main()



if __name__ == "__main__":
    unittest.main()
