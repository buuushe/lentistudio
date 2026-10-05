from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .limits import container_memory_limit

ROOT = Path(__file__).resolve().parent.parent


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


RENDER_MEMORY_OVERHEAD_MB = 256
MIN_RENDER_MEMORY_BUDGET_MB = 256


def _render_memory_budget_mb() -> int | None:
    raw = os.environ.get("RENDER_MEMORY_BUDGET_MB")
    if raw not in (None, ""):
        return int(raw)
    limit = container_memory_limit()
    if limit is None:
        return None
    return max(MIN_RENDER_MEMORY_BUDGET_MB, limit // (1024 * 1024) - RENDER_MEMORY_OVERHEAD_MB)


@dataclass(frozen=True)
class Settings:
    api_prefix: str = "/api/render"
    data_dir: Path = ROOT / "data" / "sessions"
    spa_dir: Path = ROOT.parent / "web" / "dist"
    max_upload_mb: int = 25
    max_image_side: int = 3000
    max_image_pixels: int = 80_000_000
    max_scan_side: int = 8000
    scan_preview_width: int = 1600
    max_library: int = 200
    frame_count: int = 4
    max_render_pixels: int = 160_000_000
    session_ttl_hours: float = 24.0
    session_sweep_minutes: float = 30.0
    render_concurrency: int = 2
    render_memory_budget_mb: int | None = None
    disk_high_water_mb: int = 0

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @classmethod
    def from_env(cls) -> Settings:
        data_dir = os.environ.get("DATA_DIR")
        spa_dir = os.environ.get("SPA_DIR")
        return cls(
            api_prefix=os.environ.get("API_PREFIX", cls.api_prefix).rstrip("/"),
            data_dir=Path(data_dir) if data_dir else cls.data_dir,
            spa_dir=Path(spa_dir) if spa_dir else cls.spa_dir,
            max_upload_mb=_env_int("MAX_UPLOAD_MB", cls.max_upload_mb),
            max_image_side=_env_int("MAX_IMAGE_SIDE", cls.max_image_side),
            max_image_pixels=_env_int("MAX_IMAGE_PIXELS", cls.max_image_pixels),
            max_scan_side=_env_int("MAX_SCAN_SIDE", cls.max_scan_side),
            scan_preview_width=_env_int("SCAN_PREVIEW_WIDTH", cls.scan_preview_width),
            max_library=_env_int("MAX_LIBRARY", cls.max_library),
            max_render_pixels=_env_int("MAX_RENDER_PIXELS", cls.max_render_pixels),
            session_ttl_hours=_env_float("SESSION_TTL_HOURS", cls.session_ttl_hours),
            session_sweep_minutes=_env_float("SESSION_SWEEP_MINUTES", cls.session_sweep_minutes),
            render_concurrency=_env_int("RENDER_CONCURRENCY", cls.render_concurrency),
            render_memory_budget_mb=_render_memory_budget_mb(),
            disk_high_water_mb=_env_int("DISK_HIGH_WATER_MB", cls.disk_high_water_mb),
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_env()
