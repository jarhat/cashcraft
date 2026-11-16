import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import iso_api


class IsoStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b"iso contents"


class IsoApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        app = FastAPI()
        app.include_router(iso_api.router)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend")
        self.environment = patch.dict(os.environ, {
            "ISO_BUILD_API_URL": "http://builder:8080",
            "ISO_BUILD_API_KEY": "secret-key",
        })
        self.environment.start()

    async def asyncTearDown(self):
        self.environment.stop()
        await self.client.aclose()

    async def test_build_status_and_download_use_backend_credentials(self):
        requests = []

        def upstream(request):
            requests.append(request)
            self.assertEqual(request.headers["authorization"], "Bearer secret-key")
            if request.url.path == "/v1/builds":
                return httpx.Response(200, json={"id": "run-1"})
            if request.url.path == "/v1/builds/run-1":
                return httpx.Response(200, json={"status": "completed", "profiles": [
                    {"downloads": [{"url": "http://localhost:8080/v1/isos/run-1/desktop/test.iso"}]}
                ]})
            return httpx.Response(200, stream=IsoStream(), headers={"Content-Length": "12"})

        original_client = httpx.AsyncClient
        with patch.object(iso_api.httpx, "AsyncClient", side_effect=lambda **kwargs: original_client(
            transport=httpx.MockTransport(upstream), **kwargs
        )):
            build = await self.client.post("/api/iso/builds", headers={"Content-Type": "application/json"})
            self.assertEqual(build.json(), {"id": "run-1"})
            status = await self.client.get("/api/iso/builds/run-1")
            download = status.json()["downloads"][0]
            self.assertNotIn("secret-key", status.text)
            image = await self.client.get(download["path"])
        self.assertEqual(image.content, b"iso contents")
        self.assertEqual(image.headers["content-disposition"], 'attachment; filename="test.iso"')
        self.assertEqual(str(requests[-1].url), "http://builder:8080/v1/isos/run-1/desktop/test.iso")

    async def test_rejects_unsafe_urls_and_cross_origin_redirects(self):
        def upstream(request):
            if request.url.path.startswith("/v1/builds/"):
                return httpx.Response(200, json={"status": "completed", "profiles": [
                    {"downloads": [{"url": "/v1/isos/other/profile/test.iso"}]}
                ]})
            return httpx.Response(302, headers={"Location": "http://evil.example/steal"})

        original_client = httpx.AsyncClient
        with patch.object(iso_api.httpx, "AsyncClient", side_effect=lambda **kwargs: original_client(
            transport=httpx.MockTransport(upstream), **kwargs
        )):
            self.assertEqual((await self.client.get("/api/iso/builds/run-1")).status_code, 502)
            self.assertEqual((await self.client.get("/api/iso/download/run-1/profile/test.iso")).status_code, 502)
        self.assertEqual((await self.client.post("/api/iso/builds")).status_code, 415)

    async def test_missing_configuration_returns_error(self):
        with patch.dict(os.environ, {"ISO_BUILD_API_KEY": ""}):
            response = await self.client.post("/api/iso/builds", headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 503)


if __name__ == "__main__":
    unittest.main()
