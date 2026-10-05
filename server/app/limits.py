from __future__ import annotations

import re
import shutil
import threading
import time
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path


class MemoryBudget:
    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.used = 0
        self._changed = threading.Condition()

    def fits(self, amount: int) -> bool:
        return amount <= self.capacity

    def reserve(self, amount: int) -> AbstractContextManager[None]:
        if not self.fits(amount):
            raise MemoryError(f"{amount} bytes exceed the budget of {self.capacity}")
        return self._held(amount)

    @contextmanager
    def _held(self, amount: int) -> Iterator[None]:
        with self._changed:
            self._changed.wait_for(lambda: self.used + amount <= self.capacity)
            self.used += amount
        try:
            yield
        finally:
            with self._changed:
                self.used -= amount
                self._changed.notify_all()


CGROUP_MEMORY_LIMITS = (Path("/sys/fs/cgroup/memory.max"), Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"))
UNLIMITED_CGROUP_BYTES = 1 << 60


def container_memory_limit(candidates: tuple[Path, ...] = CGROUP_MEMORY_LIMITS) -> int | None:
    for path in candidates:
        try:
            raw = path.read_text().strip()
        except OSError:
            continue
        if raw.isdigit() and int(raw) < UNLIMITED_CGROUP_BYTES:
            return int(raw)
        return None
    return None


def newest_mtime(directory: Path) -> float:
    times = [directory.stat().st_mtime]
    for path in directory.iterdir():
        try:
            times.append(path.stat().st_mtime)
        except FileNotFoundError:
            continue
    return max(times)


SESSION_DIR_RE = re.compile(r"^[0-9a-f]{32}$")


def sweep_expired_sessions(data_dir: Path, ttl_seconds: float, now: float | None = None) -> list[str]:
    now = time.time() if now is None else now
    removed = []
    if not data_dir.is_dir():
        return removed
    for directory in data_dir.iterdir():
        if not directory.is_dir() or not SESSION_DIR_RE.match(directory.name):
            continue
        if now - newest_mtime(directory) > ttl_seconds:
            shutil.rmtree(directory, ignore_errors=True)
            removed.append(directory.name)
    return removed
