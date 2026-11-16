import os
import re
from urllib.parse import quote, unquote, urljoin, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api/iso")
SEGMENT = re.compile(r"^[A-Za-z0-9_+.-]{1,200}$")


def segment(value: str) -> bool:
    return bool(SEGMENT.fullmatch(value)) and value not in {".", ".."}


def config() -> tuple[str, dict[str, str]]:
    base = os.getenv("ISO_BUILD_API_URL", "").rstrip("/")
    key = os.getenv("ISO_BUILD_API_KEY", "").strip()
    parsed = urlsplit(base)
    if not key or parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise HTTPException(503, "ISO build service is not configured.")
    return base, {"Authorization": f"Bearer {key}"}


async def request_json(method: str, path: str) -> dict:
    base, headers = config()
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.request(method, base + path, headers=headers)
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "ISO build service request failed.") from exc
    if not isinstance(result, dict):
        raise HTTPException(502, "Invalid response from ISO build service.")
    return result


@router.post("/builds")
async def start_build(request: Request):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "Content-Type must be application/json.")
    result = await request_json("POST", "/v1/builds")
    job_id = result.get("id")
    if not isinstance(job_id, str) or not segment(job_id):
        raise HTTPException(502, "Invalid build ID from ISO build service.")
    return {"id": job_id}


@router.get("/builds/{job_id}")
async def build_status(job_id: str):
    if not segment(job_id):
        raise HTTPException(400, "Invalid build ID.")
    result = await request_json("GET", f"/v1/builds/{quote(job_id, safe='')}")
    status = result.get("status")
    if not isinstance(status, str) or not status:
        raise HTTPException(502, "Invalid build status from ISO build service.")
    profiles = result.get("profiles", [])
    if not isinstance(profiles, list):
        raise HTTPException(502, "Invalid profiles from ISO build service.")
    downloads = []
    for profile in profiles:
        if not isinstance(profile, dict) or not isinstance(profile.get("downloads", []), list):
            raise HTTPException(502, "Invalid downloads from ISO build service.")
        for item in profile.get("downloads", []):
            if not isinstance(item, dict) or not isinstance(item.get("url"), str):
                raise HTTPException(502, "Invalid download URL from ISO build service.")
            parsed = urlsplit(item["url"])
            parts = [unquote(part) for part in parsed.path.split("/")]
            if parsed.query or parsed.fragment or len(parts) != 6 or parts[:3] != ["", "v1", "isos"] or parts[3] != job_id or not all(segment(part) for part in parts[3:]):
                raise HTTPException(502, "Invalid download URL from ISO build service.")
            downloads.append({
                "profile": parts[4],
                "filename": parts[5],
                "path": "/api/iso/download/" + "/".join(quote(part, safe="") for part in parts[3:]),
            })
    return {"status": status, "downloads": downloads}


@router.get("/download/{job_id}/{profile}/{filename}")
async def download_iso(job_id: str, profile: str, filename: str):
    if not all(segment(part) for part in (job_id, profile, filename)):
        raise HTTPException(400, "Invalid ISO download path.")
    base, headers = config()
    path = "/v1/isos/" + "/".join(quote(part, safe="") for part in (job_id, profile, filename))
    client = httpx.AsyncClient(timeout=httpx.Timeout(30, read=120), follow_redirects=False)
    try:
        url = base + path
        for _ in range(4):
            response = await client.send(client.build_request("GET", url, headers=headers), stream=True)
            if not response.is_redirect:
                break
            location = response.headers.get("location")
            await response.aclose()
            if not location:
                raise httpx.HTTPError("Missing redirect location")
            url = urljoin(url, location)
            target = urlsplit(url)
            origin = urlsplit(base)
            if (target.scheme, target.netloc) != (origin.scheme, origin.netloc):
                raise httpx.HTTPError("Cross-origin ISO redirect")
        else:
            raise httpx.HTTPError("Too many ISO redirects")
        response.raise_for_status()
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(502, "ISO download failed.") from exc

    async def stream():
        try:
            async for chunk in response.aiter_raw():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    output_headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if "content-length" in response.headers:
        output_headers["Content-Length"] = response.headers["content-length"]
    return StreamingResponse(stream(), media_type="application/octet-stream", headers=output_headers)
