from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import pytest

from app.limits import MemoryBudget, container_memory_limit, sweep_expired_sessions


def test_sweep_removes_only_expired_sessions(tmp_path: Path):
    old = tmp_path / ("1" * 32)
    fresh = tmp_path / ("2" * 32)
    for d in (old, fresh):
        d.mkdir()
        (d / "frame_0.jpg").write_bytes(b"x")
    stale_time = time.time() - 3 * 3600
    for path in (old, old / "frame_0.jpg"):
        os.utime(path, (stale_time, stale_time))
    removed = sweep_expired_sessions(tmp_path, ttl_seconds=2 * 3600)
    assert removed == [old.name]
    assert not old.exists() and fresh.exists()


def test_memory_budget_waits_for_a_release_and_rejects_what_never_fits():
    budget = MemoryBudget(100)
    with pytest.raises(MemoryError):
        budget.reserve(101)
    entered = threading.Event()
    first = budget.reserve(70)
    first.__enter__()

    def second() -> None:
        with budget.reserve(50):
            entered.set()

    worker = threading.Thread(target=second)
    worker.start()
    assert not entered.wait(0.1)
    first.__exit__(None, None, None)
    assert entered.wait(1.0)
    worker.join()
    assert budget.used == 0


def test_container_memory_limit_reads_cgroup_files(tmp_path: Path):
    limited = tmp_path / "limited"
    limited.write_text("1073741824\n")
    unlimited = tmp_path / "unlimited"
    unlimited.write_text("max\n")
    assert container_memory_limit((tmp_path / "missing", limited)) == 1073741824
    assert container_memory_limit((unlimited, limited)) is None
    assert container_memory_limit((tmp_path / "missing",)) is None
