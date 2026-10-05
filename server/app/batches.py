from __future__ import annotations

import json
import re
import uuid
import zipfile
from pathlib import Path

BATCH_ID_RE = re.compile(r"^[0-9a-f]{12}$")
BATCH_FILE_PREFIX = "batch_"


def new_batch_id() -> str:
    return uuid.uuid4().hex[:12]


def is_batch_id(value: str) -> bool:
    return bool(BATCH_ID_RE.match(value))


def state_path(sdir: Path, batch_id: str) -> Path:
    return sdir / f"{BATCH_FILE_PREFIX}{batch_id}.json"


def zip_path(sdir: Path, batch_id: str) -> Path:
    return sdir / f"{BATCH_FILE_PREFIX}{batch_id}.zip"


def initial_state(batch_id: str, set_numbers: list[int]) -> dict:
    return {
        "batch_id": batch_id,
        "status": "running",
        "total": len(set_numbers),
        "done": 0,
        "items": [{"set": number, "status": "pending"} for number in set_numbers],
    }


def write_state(sdir: Path, state: dict) -> None:
    target = state_path(sdir, state["batch_id"])
    staging = target.with_suffix(".tmp")
    staging.write_text(json.dumps(state))
    staging.replace(target)


def read_state(sdir: Path, batch_id: str) -> dict | None:
    path = state_path(sdir, batch_id)
    return json.loads(path.read_text()) if path.is_file() else None


def finished_items(state: dict) -> list[dict]:
    return [item for item in state["items"] if item["status"] == "done"]


def is_finished(state: dict) -> bool:
    return state["status"] != "running"


def entry_name(set_number: int, total_sets: int) -> str:
    width = max(2, len(str(total_sets)))
    return f"wigglegram_series_{set_number:0{width}d}.mp4"


def build_zip(sdir: Path, state: dict) -> Path:
    target = zip_path(sdir, state["batch_id"])
    if target.is_file():
        return target
    items = finished_items(state)
    highest = max(item["set"] for item in items)
    staging = target.with_suffix(".part")
    with zipfile.ZipFile(staging, "w", compression=zipfile.ZIP_STORED) as archive:
        for item in items:
            video = sdir / item["render"]["video_name"]
            archive.write(video, entry_name(item["set"], highest))
    staging.replace(target)
    return target
