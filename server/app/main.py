from __future__ import annotations

import asyncio
import contextlib
import json
import re
import shutil
import uuid
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from fastapi import APIRouter, FastAPI, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from . import batches, errors, processing
from .config import Settings, get_settings
from .limits import MemoryBudget, sweep_expired_sessions
from .processing import EncodingError, ProcessingError
from .spa import mount_spa

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".bmp"}
SID_RE = re.compile(r"^[0-9a-f]{32}$")
VIDEO_NAME_RE = re.compile(r"^out(_[0-9]+(-[0-9]+)*)?\.mp4$")
POSTER_NAME_RE = re.compile(r"^out(_[0-9]+(-[0-9]+)*)?\.jpg$")
DOWNSCALED_EXT = ".jpg"
DOWNSCALED_JPEG_QUALITY = 95
HOUR = 3600
MB = 1024 * 1024
MINUTE = 60

settings: Settings = get_settings()
MAX_RENDER_FRAMES = settings.max_library
THUMB_WIDTH = 240
THUMB_JPEG_QUALITY = 80
settings.data_dir.mkdir(parents=True, exist_ok=True)

render_slots = asyncio.Semaphore(settings.render_concurrency)
render_memory = MemoryBudget(settings.render_memory_budget_mb * MB) if settings.render_memory_budget_mb else None


async def sweep_sessions_forever() -> None:
    interval = settings.session_sweep_minutes * MINUTE
    ttl = settings.session_ttl_hours * HOUR
    while True:
        await run_in_threadpool(sweep_expired_sessions, settings.data_dir, ttl)
        await asyncio.sleep(interval)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    sweeper = asyncio.create_task(sweep_sessions_forever())
    yield
    sweeper.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await sweeper


app = FastAPI(title="Lenti Studio", lifespan=lifespan)
api = APIRouter(prefix=settings.api_prefix)


def session_dir(sid: str) -> Path:
    if not SID_RE.match(sid):
        raise errors.invalid_session_id()
    directory = settings.data_dir / sid
    if not directory.is_dir():
        raise errors.session_not_found()
    return directory


def frame_path(sdir: Path, index: int) -> Path:
    matches = [p for p in sdir.glob(f"frame_{index}.*") if p.stem == f"frame_{index}"]
    if not matches:
        raise errors.frame_not_found(index)
    return matches[0]


def frame_count(sdir: Path) -> int:
    return len([p for p in sdir.iterdir() if p.stem.startswith("frame_")])


SCANS_MANIFEST = "scans.json"


def scan_path(sdir: Path, index: int) -> Path:
    matches = [p for p in sdir.glob(f"scan_{index}.*") if p.stem == f"scan_{index}"]
    if not matches:
        raise errors.scan_not_found(index)
    return matches[0]


def scan_preview_path(sdir: Path, index: int) -> Path:
    return sdir / f"scanview_{index}.jpg"


def scan_names(sdir: Path) -> list[str]:
    manifest = sdir / SCANS_MANIFEST
    return json.loads(manifest.read_text()) if manifest.is_file() else []


def remember_scan_names(sdir: Path, names: list[str]) -> None:
    (sdir / SCANS_MANIFEST).write_text(json.dumps(names))


def scan_url(sid: str, index: int) -> str:
    return f"{settings.api_prefix}/scans/{sid}/{index}"


def scan_thumb_path(sdir: Path, index: int) -> Path:
    return sdir / f"scanthumb_{index}.jpg"


def scan_meta(sid: str, index: int, name: str, width: int, height: int) -> dict:
    return {
        "index": index,
        "name": name,
        "width": width,
        "height": height,
        "url": scan_url(sid, index),
        "thumb_url": f"{scan_url(sid, index)}/thumb",
    }


def check_indices(sdir: Path, indices: list[int]) -> None:
    total = frame_count(sdir)
    missing = [i for i in indices if i < 0 or i >= total]
    if missing:
        raise errors.frames_not_found(missing, total)


def versioned(url: str, version: str | None) -> str:
    return f"{url}?v={version}" if version else url


def frame_url(sid: str, index: int, version: str | None = None) -> str:
    return versioned(f"{settings.api_prefix}/frames/{sid}/{index}", version)


def thumb_url(sid: str, index: int, version: str | None = None) -> str:
    return versioned(f"{settings.api_prefix}/frames/{sid}/{index}/thumb", version)


def thumb_path(sdir: Path, index: int) -> Path:
    return sdir / f"thumb_{index}.jpg"


def write_thumb(image: np.ndarray, dest: Path) -> None:
    h, w = image.shape[:2]
    scale = min(1.0, THUMB_WIDTH / w)
    small = cv2.resize(image, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(dest), small, [cv2.IMWRITE_JPEG_QUALITY, THUMB_JPEG_QUALITY])


def frame_meta(sid: str, index: int, name: str | None, width: int, height: int, version: str | None = None) -> dict:
    return {
        "index": index,
        "name": name,
        "width": width,
        "height": height,
        "url": frame_url(sid, index, version),
        "thumb_url": thumb_url(sid, index, version),
    }


def video_url(sid: str, name: str, download: bool = False) -> str:
    query = f"name={name}&download=1" if download else f"name={name}&v={uuid.uuid4().hex[:8]}"
    return f"{settings.api_prefix}/video/{sid}?{query}"


def poster_url(sid: str, name: str) -> str:
    return f"{settings.api_prefix}/poster/{sid}?name={name}"


def ensure_disk_space() -> None:
    if settings.disk_high_water_mb <= 0:
        return
    free_mb = shutil.disk_usage(settings.data_dir).free // (1024 * 1024)
    if free_mb < settings.disk_high_water_mb:
        raise errors.disk_full()


def ensure_upload_size(upload: UploadFile) -> None:
    if upload.size is not None and upload.size > settings.max_upload_bytes:
        raise errors.file_too_large(upload.filename or "", settings.max_upload_mb)


def image_pixel_count(path: Path) -> int | None:
    header = cv2.imread(str(path), cv2.IMREAD_REDUCED_GRAYSCALE_8)
    if header is None:
        return None
    return int(header.shape[0]) * int(header.shape[1]) * 64


def downscale_if_needed(image: np.ndarray, max_side: int | None = None) -> np.ndarray:
    limit = max_side or settings.max_image_side
    h, w = image.shape[:2]
    longest = max(h, w)
    if longest <= limit:
        return image
    scale = limit / longest
    return cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


def write_scan_preview(image: np.ndarray, dest: Path) -> None:
    h, w = image.shape[:2]
    scale = min(1.0, settings.scan_preview_width / w)
    small = cv2.resize(image, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(dest), small, [cv2.IMWRITE_JPEG_QUALITY, THUMB_JPEG_QUALITY])


def store_frame(upload: UploadFile, sdir: Path, index: int) -> tuple[Path, int, int]:
    dest, reduced = store_upload(upload, sdir, f"frame_{index}", settings.max_image_side)
    write_thumb(reduced, thumb_path(sdir, index))
    h, w = reduced.shape[:2]
    return dest, w, h


def store_scan(upload: UploadFile, sdir: Path, index: int) -> tuple[Path, int, int]:
    dest, reduced = store_upload(upload, sdir, f"scan_{index}", settings.max_scan_side)
    write_scan_preview(reduced, scan_preview_path(sdir, index))
    write_thumb(reduced, scan_thumb_path(sdir, index))
    h, w = reduced.shape[:2]
    return dest, w, h


def store_upload(upload: UploadFile, sdir: Path, stem: str, max_side: int) -> tuple[Path, np.ndarray]:
    filename = upload.filename or ""
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise errors.unsupported_format(filename)
    ensure_upload_size(upload)
    dest = sdir / f"{stem}{ext}"
    with dest.open("wb") as fh:
        shutil.copyfileobj(upload.file, fh, length=1024 * 1024)
    if dest.stat().st_size > settings.max_upload_bytes:
        dest.unlink(missing_ok=True)
        raise errors.file_too_large(filename, settings.max_upload_mb)
    pixels = image_pixel_count(dest)
    if pixels is None:
        dest.unlink(missing_ok=True)
        raise errors.unreadable_image(filename)
    if pixels > settings.max_image_pixels:
        dest.unlink(missing_ok=True)
        raise errors.image_too_big(filename, settings.max_image_pixels)
    image = cv2.imread(str(dest), cv2.IMREAD_COLOR)
    if image is None:
        dest.unlink(missing_ok=True)
        raise errors.unreadable_image(filename)
    reduced = downscale_if_needed(image, max_side)
    if reduced is not image:
        dest.unlink(missing_ok=True)
        dest = sdir / f"{stem}{DOWNSCALED_EXT}"
        cv2.imwrite(str(dest), reduced, [cv2.IMWRITE_JPEG_QUALITY, DOWNSCALED_JPEG_QUALITY])
    return dest, reduced


def create_session() -> tuple[str, Path]:
    sid = uuid.uuid4().hex
    sdir = settings.data_dir / sid
    sdir.mkdir(parents=True)
    return sid, sdir


@api.post("/upload")
async def upload(files: list[UploadFile] = File(...), session_id: str | None = Form(None)) -> dict:
    if not files:
        raise errors.no_files()
    ensure_disk_space()
    if session_id:
        sdir = session_dir(session_id)
        sid = session_id
        start = frame_count(sdir)
        created = False
    else:
        sid, sdir = create_session()
        start = 0
        created = True
    if start + len(files) > settings.max_library:
        if created:
            shutil.rmtree(sdir, ignore_errors=True)
        raise errors.library_full(settings.max_library)

    frames = []
    written: list[Path] = []
    try:
        for offset, up in enumerate(files):
            index = start + offset
            dest, w, h = await run_in_threadpool(store_frame, up, sdir, index)
            written.append(dest)
            frames.append(frame_meta(sid, index, up.filename, w, h))
    except errors.ApiError:
        if created:
            shutil.rmtree(sdir, ignore_errors=True)
        else:
            for path in written:
                path.unlink(missing_ok=True)
        raise

    return {"session_id": sid, "frames": frames, "total": start + len(files)}


@api.api_route("/frames/{sid}/{index}", methods=["GET", "HEAD"])
def get_frame(sid: str, index: int) -> FileResponse:
    return FileResponse(frame_path(session_dir(sid), index))


def ensure_thumb(sdir: Path, index: int) -> Path:
    thumb = thumb_path(sdir, index)
    if not thumb.is_file():
        image = cv2.imread(str(frame_path(sdir, index)), cv2.IMREAD_COLOR)
        if image is None:
            raise errors.unreadable_image(f"frame_{index}")
        write_thumb(image, thumb)
    return thumb


@api.delete("/session/{sid}")
async def close_session(sid: str) -> dict:
    shutil.rmtree(session_dir(sid), ignore_errors=True)
    return {"closed": True}


@api.api_route("/frames/{sid}/{index}/thumb", methods=["GET", "HEAD"])
async def get_thumb(sid: str, index: int) -> FileResponse:
    sdir = session_dir(sid)
    thumb = await run_in_threadpool(ensure_thumb, sdir, index)
    return FileResponse(thumb, media_type="image/jpeg")


class PointModel(BaseModel):
    x: float
    y: float


class CropModel(BaseModel):
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    w: float = Field(..., gt=0.0, le=1.0)
    h: float = Field(..., gt=0.0, le=1.0)


@api.post("/scans")
async def upload_scans(files: list[UploadFile] = File(...), session_id: str | None = Form(None)) -> dict:
    if not files:
        raise errors.no_files()
    ensure_disk_space()
    if session_id:
        sdir = session_dir(session_id)
        sid = session_id
        created = False
    else:
        sid, sdir = create_session()
        created = True
    names = scan_names(sdir)
    start = len(names)
    if (start + len(files)) * min(processing.SPLIT_COUNTS) > settings.max_library:
        if created:
            shutil.rmtree(sdir, ignore_errors=True)
        raise errors.library_full(settings.max_library)

    scans = []
    written: list[Path] = []
    try:
        for offset, up in enumerate(files):
            index = start + offset
            dest, w, h = await run_in_threadpool(store_scan, up, sdir, index)
            written.append(dest)
            names.append(up.filename or f"scan_{index}")
            scans.append(scan_meta(sid, index, names[-1], w, h))
    except errors.ApiError:
        if created:
            shutil.rmtree(sdir, ignore_errors=True)
        else:
            for path in written:
                path.unlink(missing_ok=True)
        raise
    remember_scan_names(sdir, names)
    return {"session_id": sid, "scans": scans, "total": len(names)}


def existing_scan_image(sdir: Path, index: int, path: Path) -> FileResponse:
    if not path.is_file():
        raise errors.scan_not_found(index)
    return FileResponse(path, media_type="image/jpeg")


@api.api_route("/scans/{sid}/{index}", methods=["GET", "HEAD"])
def get_scan_preview(sid: str, index: int) -> FileResponse:
    sdir = session_dir(sid)
    return existing_scan_image(sdir, index, scan_preview_path(sdir, index))


@api.api_route("/scans/{sid}/{index}/thumb", methods=["GET", "HEAD"])
def get_scan_thumb(sid: str, index: int) -> FileResponse:
    sdir = session_dir(sid)
    return existing_scan_image(sdir, index, scan_thumb_path(sdir, index))


class ScanGeometry(BaseModel):
    axis: Literal["x", "y"] = "x"
    box: CropModel
    gap: float = Field(0.0, ge=0.0, le=0.5)


class SplitRequest(ScanGeometry):
    session_id: str
    count: Literal[2, 3, 4]
    scans: list[ScanGeometry] | None = Field(None, min_length=1, max_length=settings.max_library)

    def geometry_for(self, scan_index: int) -> ScanGeometry:
        return self.scans[scan_index] if self.scans and scan_index < len(self.scans) else self


def drop_split_products(sdir: Path) -> None:
    for path in sdir.iterdir():
        if path.stem.startswith(("frame_", "thumb_", "out_", batches.BATCH_FILE_PREFIX)):
            path.unlink(missing_ok=True)


def cut_scan(sdir: Path, sid: str, scan_index: int, name: str, req: SplitRequest, version: str) -> list[dict]:
    image = cv2.imread(str(scan_path(sdir, scan_index)), cv2.IMREAD_COLOR)
    if image is None:
        raise errors.unreadable_image(name)
    h, w = image.shape[:2]
    geometry = req.geometry_for(scan_index)
    box = (geometry.box.x, geometry.box.y, geometry.box.w, geometry.box.h)
    rects = processing.split_rects((w, h), req.count, geometry.axis, box, geometry.gap)
    frames = []
    for k, (x, y, cw, ch) in enumerate(rects):
        index = scan_index * req.count + k
        piece = downscale_if_needed(np.ascontiguousarray(image[y : y + ch, x : x + cw]))
        dest = sdir / f"frame_{index}{DOWNSCALED_EXT}"
        cv2.imwrite(str(dest), piece, [cv2.IMWRITE_JPEG_QUALITY, DOWNSCALED_JPEG_QUALITY])
        write_thumb(piece, thumb_path(sdir, index))
        ph, pw = piece.shape[:2]
        frames.append(frame_meta(sid, index, f"{name} · {k + 1}", pw, ph, version))
    return frames


def split_job(sdir: Path, req: SplitRequest) -> dict:
    names = scan_names(sdir)
    if not names:
        raise errors.no_scans()
    if len(names) * req.count > settings.max_library:
        raise errors.library_full(settings.max_library)
    drop_split_products(sdir)
    version = uuid.uuid4().hex[:8]
    frames = []
    for scan_index, name in enumerate(names):
        frames.extend(cut_scan(sdir, req.session_id, scan_index, name, req, version))
    return {"session_id": req.session_id, "frames": frames, "total": len(frames)}


@api.post("/split")
async def split(req: SplitRequest) -> dict:
    sdir = session_dir(req.session_id)
    try:
        return await run_in_threadpool(split_job, sdir, req)
    except ProcessingError as e:
        raise errors.processing_failed(e.code, str(e), **e.params) from e


class AdjustModel(BaseModel):
    brightness: float = Field(0, ge=-100, le=100)
    contrast: float = Field(0, ge=-100, le=100)
    sharpen: int = Field(0, ge=0, le=processing.SHARPEN_MAX)


class SetLoopModel(BaseModel):
    mode: Literal["pingpong", "pingpong_hold", "forward", "backward", "ends", "middle", "custom"] = "pingpong"
    pattern: list[int] | None = Field(None, min_length=2, max_length=64)
    cycles: int = Field(1, ge=1, le=processing.MAX_CYCLES_PER_SET)


def unique_frame_indices(v: list[int]) -> list[int]:
    if len(set(v)) != len(v) or any(i < 0 for i in v):
        raise ValueError("order must contain distinct non-negative frame indices")
    return v


MIN_SET_SIZE = 2
MAX_SET_SIZE = 5


class RenderJob(BaseModel):
    order: list[int] = Field(..., min_length=MIN_SET_SIZE, max_length=MAX_RENDER_FRAMES)
    points: list[PointModel] = Field(..., min_length=MIN_SET_SIZE, max_length=MAX_RENDER_FRAMES)
    frames_per_set: int = Field(settings.frame_count, ge=MIN_SET_SIZE, le=MAX_SET_SIZE)
    mode: Literal["pingpong", "pingpong_hold", "forward", "backward", "ends", "middle", "custom"] = "pingpong"
    pattern: list[int] | None = Field(None, min_length=2, max_length=64)
    set_mode: Literal["forward", "pingpong", "forward_ease", "pingpong_ease", "swing", "sweep"] = "forward"
    cycles_per_set: int = Field(1, ge=1, le=processing.MAX_CYCLES_PER_SET)
    shared_focus: bool = True
    loops: int | None = Field(None, ge=1, le=processing.MAX_LOOPS)
    composition: Literal["single", "crossfade", "double", "split", "mosaic", "triptych"] = "single"
    transition_frames: int = Field(0, ge=0, le=processing.MAX_TRANSITION_FRAMES)
    parallax_zoom: float = Field(0.0, ge=0, le=processing.MAX_PARALLAX_ZOOM)
    set_loops: list[SetLoopModel] | None = Field(None, min_length=1, max_length=MAX_RENDER_FRAMES // MIN_SET_SIZE)
    fps: int = Field(10, ge=1, le=60)
    duration: float = Field(6.0, gt=0, le=120)
    max_width: int | None = Field(None, ge=64, le=8192)
    preset: Literal["free", "ig_portrait", "ig_square", "ig_story", "ig_landscape", "custom"] = "free"
    anchor: PointModel | None = None
    crop: CropModel | None = None
    adjustments: list[AdjustModel] | None = Field(None, min_length=MIN_SET_SIZE, max_length=MAX_RENDER_FRAMES)

    _order_unique = field_validator("order")(classmethod(lambda cls, v: unique_frame_indices(v)))

    @model_validator(mode="after")
    def _one_point_and_adjustment_per_frame(self) -> RenderJob:
        if len(self.order) % self.frames_per_set:
            raise ValueError(f"order must contain whole sets of {self.frames_per_set} frames")
        if len(self.points) != len(self.order):
            raise ValueError("points must match the order one to one")
        if self.adjustments is not None and len(self.adjustments) != len(self.order):
            raise ValueError("adjustments must match the order one to one")
        if self.set_loops is not None and len(self.set_loops) != self.set_count:
            raise ValueError("set_loops must hold one loop per set of frames")
        return self

    @property
    def set_count(self) -> int:
        return len(self.order) // self.frames_per_set


class RenderRequest(RenderJob):
    session_id: str


MAX_BATCH_ITEMS = MAX_RENDER_FRAMES // MIN_SET_SIZE


class BatchRequest(BaseModel):
    session_id: str
    items: list[RenderJob] = Field(..., min_length=1, max_length=MAX_BATCH_ITEMS)
    set_numbers: list[int] = Field(..., min_length=1, max_length=MAX_BATCH_ITEMS)

    @model_validator(mode="after")
    def _one_set_number_per_item(self) -> BatchRequest:
        if len(self.set_numbers) != len(self.items):
            raise ValueError("set_numbers must match the items one to one")
        if any(number < 1 for number in self.set_numbers):
            raise ValueError("set numbers start at 1")
        return self


def run_render(req: RenderJob, paths: list[Path], video: Path) -> dict:
    adjustments = [processing.Adjust(a.brightness, a.contrast, a.sharpen) for a in req.adjustments] if req.adjustments else None
    info = processing.render(
        paths,
        [(p.x, p.y) for p in req.points],
        video,
        mode=req.mode,
        fps=req.fps,
        duration=req.duration,
        max_width=req.max_width,
        preset=req.preset,
        anchor_frac=(req.anchor.x, req.anchor.y) if req.anchor else None,
        crop_fraction=(req.crop.x, req.crop.y, req.crop.w, req.crop.h) if req.crop else None,
        adjustments=adjustments,
        custom_pattern=req.pattern,
        frames_per_set=req.frames_per_set,
        set_mode=req.set_mode,
        cycles_per_set=req.cycles_per_set,
        max_pixels=settings.max_render_pixels,
        shared_focus=req.shared_focus,
        loops=req.loops,
        composition=req.composition,
        transition_frames=req.transition_frames,
        parallax_zoom=req.parallax_zoom,
        set_loops=[processing.SetLoop(loop.mode, loop.pattern, loop.cycles) for loop in req.set_loops] if req.set_loops else None,
        reserve_memory=render_memory.reserve if render_memory else None,
    )
    return {**info, "size_bytes": video.stat().st_size}


def video_name_for(order: list[int]) -> str:
    return "out_" + "-".join(str(i) for i in order) + ".mp4"


def render_response(sid: str, video_name: str, info: dict) -> dict:
    return {
        "video_url": video_url(sid, video_name),
        "download_url": video_url(sid, video_name, download=True),
        "poster_url": poster_url(sid, Path(info["poster"]).name),
        "video_name": video_name,
        "width": info["width"],
        "height": info["height"],
        "frames": info["frames"],
        "fps": info["fps"],
        "duration": info["duration"],
        "size_bytes": info["size_bytes"],
    }


def error_code_of(error: ProcessingError | EncodingError) -> str:
    return error.code if isinstance(error, ProcessingError) else "encode_failed"


async def render_job(sid: str, sdir: Path, job: RenderJob) -> dict:
    paths = [frame_path(sdir, idx) for idx in job.order]
    video_name = video_name_for(job.order)
    async with render_slots:
        info = await run_in_threadpool(run_render, job, paths, sdir / video_name)
    return render_response(sid, video_name, info)


@api.post("/render")
async def render(req: RenderRequest) -> dict:
    sdir = session_dir(req.session_id)
    check_indices(sdir, req.order)
    try:
        return await render_job(req.session_id, sdir, req)
    except ProcessingError as e:
        raise errors.processing_failed(e.code, str(e), **e.params) from e
    except EncodingError as e:
        raise errors.encoding_failed(str(e)) from e


running_batches: set[asyncio.Task] = set()
cancelled_batches: set[str] = set()


def failed_item(item: dict, error: ProcessingError | EncodingError) -> dict:
    params = error.params if isinstance(error, ProcessingError) else {}
    code = f"render.{error_code_of(error)}"
    return {**item, "status": "failed", "error": {"code": code, "message": str(error), "params": params}}


async def render_batch_items(sid: str, sdir: Path, state: dict, jobs: list[RenderJob]) -> None:
    for position, job in enumerate(jobs):
        if state["batch_id"] in cancelled_batches:
            state["status"] = "cancelled"
            return
        item = state["items"][position]
        try:
            state["items"][position] = {**item, "status": "done", "render": await render_job(sid, sdir, job)}
        except (ProcessingError, EncodingError) as e:
            state["items"][position] = failed_item(item, e)
        state["done"] = position + 1
        batches.write_state(sdir, state)
    state["status"] = "done"


async def run_batch(sid: str, sdir: Path, state: dict, jobs: list[RenderJob]) -> None:
    try:
        await render_batch_items(sid, sdir, state, jobs)
    except (OSError, errors.ApiError):
        state["status"] = "failed"
    finally:
        cancelled_batches.discard(state["batch_id"])
        with contextlib.suppress(OSError):
            batches.write_state(sdir, state)


def batch_view(sid: str, state: dict) -> dict:
    ready = batches.is_finished(state) and batches.finished_items(state)
    zip_url = f"{settings.api_prefix}/render/batch/{sid}/{state['batch_id']}/zip" if ready else None
    return {**state, "zip_url": zip_url}


def batch_state(sid: str, batch_id: str) -> tuple[Path, dict]:
    sdir = session_dir(sid)
    state = batches.read_state(sdir, batch_id) if batches.is_batch_id(batch_id) else None
    if state is None:
        raise errors.batch_not_found()
    return sdir, state


@api.post("/render/batch")
async def start_batch(req: BatchRequest) -> dict:
    sdir = session_dir(req.session_id)
    for job in req.items:
        check_indices(sdir, job.order)
    state = batches.initial_state(batches.new_batch_id(), req.set_numbers)
    batches.write_state(sdir, state)
    task = asyncio.create_task(run_batch(req.session_id, sdir, state, req.items))
    running_batches.add(task)
    task.add_done_callback(running_batches.discard)
    return batch_view(req.session_id, state)


@api.get("/render/batch/{sid}/{batch_id}")
def get_batch(sid: str, batch_id: str) -> dict:
    _, state = batch_state(sid, batch_id)
    return batch_view(sid, state)


@api.delete("/render/batch/{sid}/{batch_id}")
def cancel_batch(sid: str, batch_id: str) -> dict:
    _, state = batch_state(sid, batch_id)
    if not batches.is_finished(state):
        cancelled_batches.add(batch_id)
    return batch_view(sid, state)


@api.get("/render/batch/{sid}/{batch_id}/zip")
async def get_batch_zip(sid: str, batch_id: str) -> FileResponse:
    sdir, state = batch_state(sid, batch_id)
    if not batches.is_finished(state) or not batches.finished_items(state):
        raise errors.batch_not_ready()
    try:
        archive = await run_in_threadpool(batches.build_zip, sdir, state)
    except FileNotFoundError as e:
        raise errors.video_not_found() from e
    return FileResponse(archive, media_type="application/zip", filename=f"wigglegram_series_{batch_id}.zip")


class MatchRequest(BaseModel):
    session_id: str
    ref_index: int = Field(..., ge=0)
    point: PointModel | None = None
    targets: list[int] = Field(default_factory=list, max_length=MAX_RENDER_FRAMES)

    _targets_unique = field_validator("targets")(classmethod(lambda cls, v: unique_frame_indices(v)))


def read_gray(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise errors.unreadable_image(path.name)
    return image


def match_job(sdir: Path, req: MatchRequest) -> dict:
    ref = read_gray(frame_path(sdir, req.ref_index))
    if req.point is None:
        rx, ry = processing.suggest_point(ref)
        ref_point = {"index": req.ref_index, "x": rx, "y": ry, "suggested": True}
    else:
        rx, ry = req.point.x, req.point.y
        ref_point = {"index": req.ref_index, "x": rx, "y": ry, "suggested": False}
    results = []
    for idx in req.targets:
        if idx == req.ref_index:
            continue
        target = read_gray(frame_path(sdir, idx))
        (x, y), score = processing.match_point(ref, target, (rx, ry))
        results.append({"index": idx, "x": x, "y": y, "score": round(score, 3)})
    return {"ref": ref_point, "results": results}


@api.post("/match")
async def match(req: MatchRequest) -> dict:
    sdir = session_dir(req.session_id)
    check_indices(sdir, [req.ref_index, *req.targets])
    return await run_in_threadpool(match_job, sdir, req)


class PaletteRequest(BaseModel):
    session_id: str
    indices: list[int] = Field(..., min_length=1, max_length=MAX_RENDER_FRAMES)

    _indices_unique = field_validator("indices")(classmethod(lambda cls, v: unique_frame_indices(v)))


def palette_job(sdir: Path, indices: list[int]) -> dict:
    features = []
    for index in indices:
        image = cv2.imread(str(ensure_thumb(sdir, index)), cv2.IMREAD_COLOR)
        if image is None:
            raise errors.unreadable_image(f"thumb_{index}")
        features.append(
            {
                "index": index,
                "signature": processing.color_signature(image),
                "structure": processing.structure_signature(image),
                "tone": processing.tone_signature(image),
            }
        )
    return {"features": features}


@api.post("/palette")
async def palette(req: PaletteRequest) -> dict:
    sdir = session_dir(req.session_id)
    check_indices(sdir, req.indices)
    return await run_in_threadpool(palette_job, sdir, req.indices)


class OrderRequest(BaseModel):
    session_id: str
    order: list[int] = Field(..., min_length=MIN_SET_SIZE, max_length=MAX_SET_SIZE)
    points: list[PointModel] | None = Field(None, min_length=MIN_SET_SIZE, max_length=MAX_SET_SIZE)

    _order_unique = field_validator("order")(classmethod(lambda cls, v: unique_frame_indices(v)))

    @model_validator(mode="after")
    def _one_point_per_frame(self) -> OrderRequest:
        if self.points is not None and len(self.points) != len(self.order):
            raise ValueError("points must match the order one to one")
        return self


def order_job(sdir: Path, req: OrderRequest) -> dict:
    grays = [read_gray(frame_path(sdir, idx)) for idx in req.order]
    points = [(p.x, p.y) for p in req.points] if req.points else None
    result = processing.estimate_order(grays, points)
    result["order"] = [req.order[i] for i in result["order"]]
    return result


@api.post("/order")
async def order(req: OrderRequest) -> dict:
    sdir = session_dir(req.session_id)
    check_indices(sdir, req.order)
    try:
        return await run_in_threadpool(order_job, sdir, req)
    except ProcessingError as e:
        return {"order": None, "error": {"code": f"render.{e.code}", "message": str(e), "params": e.params}}


def rendered_file(sid: str, name: str, pattern: re.Pattern[str]) -> Path:
    sdir = session_dir(sid)
    if not pattern.match(name):
        raise errors.invalid_video_name()
    path = sdir / name
    if not path.is_file():
        raise errors.video_not_found()
    return path


@api.api_route("/video/{sid}", methods=["GET", "HEAD"])
def get_video(sid: str, name: str = "out.mp4", download: int = 0) -> FileResponse:
    path = rendered_file(sid, name, VIDEO_NAME_RE)
    kwargs = {"filename": name.replace("out", "wigglegram", 1)} if download else {}
    return FileResponse(path, media_type="video/mp4", **kwargs)


@api.api_route("/poster/{sid}", methods=["GET", "HEAD"])
def get_poster(sid: str, name: str) -> FileResponse:
    return FileResponse(rendered_file(sid, name, POSTER_NAME_RE), media_type="image/jpeg")


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


app.include_router(api)
mount_spa(app, settings.spa_dir)
