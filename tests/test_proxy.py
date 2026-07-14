import unittest
from types import SimpleNamespace

import httpx
from starlette.datastructures import Headers

from app.main import is_allowed, parse_redirect, parse_target, send_upstream, strip_nested_proxy


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


if __name__ == "__main__":
    unittest.main()
