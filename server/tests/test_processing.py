from __future__ import annotations

import contextlib
from pathlib import Path

import cv2
import numpy as np
import pytest

from app import processing

W, H = 400, 300
BASE = (200.0, 150.0)
SHIFTS = [(-30, 4), (-10, -3), (12, 5), (28, -6)]


def make_frames() -> tuple[list[np.ndarray], list[tuple[float, float]]]:
    frames, points = [], []
    for dx, dy in SHIFTS:
        im = np.full((H, W, 3), 40, dtype=np.uint8)
        cv2.rectangle(im, (20 + 2 * dx, 20), (120 + 2 * dx, 120), (90, 90, 200), -1)
        cx, cy = int(BASE[0] + dx), int(BASE[1] + dy)
        cv2.circle(im, (cx, cy), 18, (255, 255, 255), -1)
        frames.append(im)
        points.append((float(cx), float(cy)))
    return frames, points


def centroid_of_white(im: np.ndarray) -> tuple[float, float]:
    mask = (im.min(axis=2) > 200).astype(np.uint8)
    m = cv2.moments(mask, binaryImage=True)
    assert m["m00"] > 0, "white dot not found"
    return m["m10"] / m["m00"], m["m01"] / m["m00"]


def test_alignment_keeps_focus_point_fixed():
    frames, points = make_frames()
    out = processing.align_frames(frames, points)
    assert len(out) == 4
    h, w = out[0].shape[:2]
    assert w % 2 == 0 and h % 2 == 0
    for f in out:
        assert f.shape == out[0].shape
    centers = [centroid_of_white(f) for f in out]
    for c in centers[1:]:
        assert abs(c[0] - centers[0][0]) <= 1.0
        assert abs(c[1] - centers[0][1]) <= 1.0
    assert w <= W - (max(s[0] for s in SHIFTS) - min(s[0] for s in SHIFTS))


def test_crop_preset_gives_exact_size_and_keeps_point():
    frames, points = make_frames()
    out = processing.align_frames(frames, points, preset="ig_portrait")
    assert all(f.shape[:2] == (1350, 1080) for f in out)
    centers = [centroid_of_white(f) for f in out]
    for c in centers[1:]:
        assert abs(c[0] - centers[0][0]) <= 3.0
        assert abs(c[1] - centers[0][1]) <= 3.0


def test_fit_aspect_stays_inside_common_area():
    crop = (10, 20, 300, 200)
    for anchor in [(0, 0), (1000, 1000), (160, 120)]:
        x, y, w, h = processing.fit_aspect(crop, 4 / 5, anchor)
        assert x >= 10 and y >= 20 and x + w <= 310 and y + h <= 220
        assert abs(w / h - 0.8) < 0.02


def test_sequences():
    pingpong = processing.loop_pattern(4, "pingpong")
    assert processing.repeat_to_fill(pingpong, 6, 1) == [0, 1, 2, 3, 2, 1]
    assert processing.repeat_to_fill(processing.loop_pattern(4, "forward"), 8, 1) == [0, 1, 2, 3, 0, 1, 2, 3]
    seq = processing.repeat_to_fill(pingpong, 10, 6)
    assert len(seq) % 6 == 0 and len(seq) <= 60
    assert processing.loop_pattern(4, "pingpong_hold") == [0, 0, 1, 2, 3, 3, 2, 1]
    assert processing.loop_pattern(4, "backward") == [3, 2, 1, 0]
    assert processing.loop_pattern(4, "ends") == [0, 3]
    assert processing.loop_pattern(4, "middle") == [1, 2]
    assert processing.loop_pattern(4, "custom", [0, 1, 3, 1]) == [0, 1, 3, 1]
    with pytest.raises(ValueError):
        processing.loop_pattern(4, "custom", [0, 4])
    with pytest.raises(ValueError):
        processing.loop_pattern(4, "custom", [2, 2])
    with pytest.raises(ValueError):
        processing.loop_pattern(4, "custom")


def test_series_sequences():
    assert processing.set_pattern(1, "pingpong") == [0]
    assert processing.set_pattern(2, "pingpong") == [0, 1]
    assert processing.set_pattern(3, "pingpong") == [0, 1, 2, 1]
    assert processing.set_pattern(3, "forward") == [0, 1, 2]
    assert processing.series_pattern(1, 4, "pingpong") == [0, 1, 2, 3, 2, 1]
    assert processing.series_pattern(2, 4, "ends", "forward") == [0, 3, 4, 7]
    assert processing.series_pattern(3, 4, "ends", "pingpong") == [0, 3, 4, 7, 8, 11, 7, 4]
    assert processing.series_pattern(2, 4, "ends", "forward", cycles_per_set=2) == [0, 3, 0, 3, 4, 7, 4, 7]
    assert [processing.edge_dwell(k, 5, 4) for k in range(5)] == [4, 3, 1, 3, 4]
    assert [processing.edge_dwell(k, 3, 3) for k in range(3)] == [3, 1, 3]
    assert [processing.edge_dwell(k, 2, 3) for k in range(2)] == [3, 3]
    assert [loop.cycles for loop in processing.dwell_loops(3, "pingpong_ease", 3, "ends", None)] == [3, 1, 3]
    assert [loop.cycles for loop in processing.dwell_loops(3, "forward_ease", 2, "ends", None)] == [2, 1, 2]
    assert [loop.cycles for loop in processing.dwell_loops(3, "forward_ease", 1, "ends", None)] == [1, 1, 1]
    assert [loop.cycles for loop in processing.dwell_loops(3, "pingpong", 2, "ends", None)] == [2, 2, 2]
    assert [processing.left_dwell(k, 4, 4) for k in range(4)] == [4, 3, 2, 1]
    assert [processing.left_dwell(k, 3, 4) for k in range(3)] == [4, 3, 1]
    assert [loop.cycles for loop in processing.dwell_loops(4, "swing", 4, "ends", None)] == [4, 3, 2, 1]
    assert [loop.cycles for loop in processing.dwell_loops(2, "swing", 3, "ends", None)] == [3, 1]
    assert processing.series_pattern(3, 4, "pingpong", "sweep") == list(range(12)) + list(range(10, 0, -1))
    assert processing.series_pattern(3, 4, "ends", "sweep", cycles_per_set=3) == [0, 11]
    assert processing.series_pattern(2, 4, "custom", "sweep", custom=[0, 3]) == list(range(8)) + list(range(6, 0, -1))
    assert processing.series_pattern(2, 4, "backward", "sweep") == list(range(7, -1, -1))

    assert processing.series_pattern(3, 4, "ends", "forward_ease", 2) == [0, 3, 0, 3, 4, 7, 8, 11, 8, 11]

    assert processing.repeat_to_fill(processing.series_pattern(3, 4, "pingpong"), 10, 6) == processing.series_pattern(3, 4, "pingpong") * 3
    assert processing.repeat_to_fill(processing.series_pattern(1, 4, "pingpong"), 10, 6, loops=2) == [0, 1, 2, 3, 2, 1] * 2
    assert processing.repeat_to_fill(processing.series_pattern(2, 4, "ends", "sweep"), 10, 60, loops=1) == [0, 7]
    with pytest.raises(processing.ProcessingError, match="loops"):
        processing.repeat_to_fill([0, 1], 10, 1, loops=9)

    with pytest.raises(processing.ProcessingError, match="set_mode"):
        processing.set_pattern(2, "spiral")
    with pytest.raises(processing.ProcessingError, match="cycles_per_set"):
        processing.series_pattern(2, 4, "pingpong", cycles_per_set=9)


def test_render_two_sets_keeps_every_focus_point_fixed(tmp_path: Path):
    first, first_points = make_frames()
    second, second_points = _textured_frames(SHIFTS)
    paths = []
    for i, f in enumerate(first + second):
        pth = tmp_path / f"f{i}.png"
        cv2.imwrite(str(pth), f)
        paths.append(pth)
    info = processing.render(
        paths,
        first_points + second_points,
        tmp_path / "series.mp4",
        mode="ends",
        set_mode="pingpong",
        cycles_per_set=2,
        fps=8,
        duration=1,
        frames_per_set=4,
    )
    assert info["frames"] == len(processing.series_pattern(2, 4, "ends", "pingpong", 2))
    assert (tmp_path / "series.mp4").stat().st_size > 1000
    with pytest.raises(processing.ProcessingError, match="multiple"):
        processing.render(paths[:6], (first_points + second_points)[:6], tmp_path / "bad.mp4", frames_per_set=4)
    with pytest.raises(processing.ProcessingError, match="Too many frames") as too_large:
        processing.render(paths, first_points + second_points, tmp_path / "big.mp4", frames_per_set=4, max_pixels=1000)
    assert too_large.value.code == "too_large" and too_large.value.params["frames"] == 8


def test_shared_focus_moves_sets_onto_one_point_and_separate_focus_keeps_the_framing():
    _, first = make_frames()
    second = [(x + 100.0, y) for x, y in first]
    sizes = [(W, H)] * 8
    shared = processing.compute_alignment(sizes, first + second, frames_per_set=4, shared_focus=True)
    assert all(np.allclose(t, shared.target) for t in shared.targets)
    assert np.isclose(shared.offsets[4][0] - shared.offsets[0][0], -100.0)

    separate = processing.compute_alignment(sizes, first + second, frames_per_set=4, shared_focus=False)
    assert np.isclose(separate.targets[4][0] - separate.targets[0][0], 100.0)
    assert all(np.allclose(separate.offsets[i], separate.offsets[i + 4]) for i in range(4))
    assert separate.crop[2] > shared.crop[2]
    assert np.isclose(separate.target[0], (separate.targets[0][0] + separate.targets[4][0]) / 2)

    plan = processing.plan_frames(sizes, first + second, preset="ig_square", frames_per_set=4, shared_focus=False)
    assert plan.out_size == (1080, 1080)


def write_frames(tmp_path: Path, frames: list[np.ndarray]) -> list[Path]:
    paths = []
    for i, f in enumerate(frames):
        pth = tmp_path / f"f{i}.png"
        cv2.imwrite(str(pth), f)
        paths.append(pth)
    return paths


def test_render_reserves_its_estimated_memory_and_writes_a_poster(tmp_path: Path):
    frames, points = make_frames()
    paths = write_frames(tmp_path, frames)
    reserved: list[int] = []

    @contextlib.contextmanager
    def reserve(amount: int):
        reserved.append(amount)
        yield

    info = processing.render(paths, points, tmp_path / "o.mp4", fps=6, duration=1, reserve_memory=reserve)
    assert info["frames"] == 6 and len(reserved) == 1
    out_pixels = info["width"] * info["height"]
    assert reserved[0] >= processing.ENCODER_BASE_BYTES + processing.ENCODER_BYTES_PER_PIXEL * out_pixels
    poster = cv2.imread(info["poster"])
    assert poster.shape == (info["height"], info["width"], 3)


def test_render_that_does_not_fit_the_memory_budget_is_too_large(tmp_path: Path):
    frames, points = make_frames()
    paths = write_frames(tmp_path, frames)

    def reserve(amount: int):
        raise MemoryError

    with pytest.raises(processing.ProcessingError) as caught:
        processing.render(paths, points, tmp_path / "o.mp4", fps=6, duration=1, reserve_memory=reserve)
    assert caught.value.code == "too_large" and caught.value.params["frames"] == 4


def test_estimate_counts_blends_and_sync_compositions():
    sizes = [(W, H)] * 8
    plan = processing.plan_frames(sizes, [BASE] * 8, frames_per_set=4)
    plain = processing.estimate_render_bytes(sizes, plan, [(0, None, 0.0), (1, None, 0.0)], "single", 2)
    faded = processing.estimate_render_bytes(sizes, plan, [(0, None, 0.0), (3, 4, 0.5)], "crossfade", 2)
    frame_bytes = processing.I420_BYTES_PER_PIXEL * plan.out_size[0] * plan.out_size[1]
    assert faded - plain == int(frame_bytes)


def test_encode_mp4_from_i420_frames(tmp_path: Path):
    frames, points = make_frames()
    out = [processing.to_i420(f) for f in processing.align_frames(frames, points)]
    path = processing.encode_mp4(out, [0, 1, 2, 3], 10, tmp_path / "out.mp4", pix_fmt="yuv420p")
    cap = cv2.VideoCapture(str(path))
    ok, first = cap.read()
    assert ok and first.shape[:2] == (out[0].shape[0] * 2 // 3, out[0].shape[1])
    assert int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) == 4


def test_encode_mp4(tmp_path: Path):

    frames, points = make_frames()
    out = processing.align_frames(frames, points)
    seq = processing.repeat_to_fill(processing.loop_pattern(4, "pingpong"), 10, 1.2)
    path = processing.encode_mp4(out, seq, 10, tmp_path / "out.mp4")
    assert path.is_file() and path.stat().st_size > 1000
    cap = cv2.VideoCapture(str(path))
    assert cap.isOpened()
    assert int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) == len(seq)
    assert int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) == out[0].shape[1]


def test_adjust_identity_and_direction():
    frames, _ = make_frames()
    im = frames[0]
    assert processing.apply_adjust(im, processing.Adjust()) is im
    brighter = processing.apply_adjust(im, processing.Adjust(brightness=50))
    assert brighter.mean() > im.mean() + 30
    darker = processing.apply_adjust(im, processing.Adjust(brightness=-50))
    assert darker.mean() < im.mean()
    hi = processing.apply_adjust(im, processing.Adjust(contrast=100))
    assert hi[0, 0, 0] < im[0, 0, 0]
    assert hi.shape == im.shape and hi.dtype == np.uint8


def test_sharpen_increases_edge_energy_and_is_bounded():
    frames, _ = make_frames()
    im = cv2.GaussianBlur(frames[0], (0, 0), 2.0)

    def lap(a: np.ndarray) -> float:
        return float(np.abs(cv2.Laplacian(a.astype(np.float32), cv2.CV_32F)).mean())

    e0 = lap(im)
    e1 = lap(processing.apply_adjust(im, processing.Adjust(sharpen=1)))
    e3 = lap(processing.apply_adjust(im, processing.Adjust(sharpen=3)))
    assert e0 < e1 < e3
    assert abs(processing.SHARPEN_KERNEL.sum() - 1.0) < 1e-6
    flat = np.full((20, 20, 3), 100, np.uint8)
    assert np.array_equal(processing.apply_adjust(flat, processing.Adjust(sharpen=3)), flat)


def test_render_with_adjustments(tmp_path: Path):
    frames, points = make_frames()
    paths = []
    for i, f in enumerate(frames):
        pth = tmp_path / f"f{i}.png"
        cv2.imwrite(str(pth), f)
        paths.append(pth)
    adj = [processing.Adjust(10, 20, 1)] * 4
    info = processing.render(paths, points, tmp_path / "o.mp4", fps=6, duration=1, adjustments=adj)
    assert info["frames"] == 6 and (tmp_path / "o.mp4").stat().st_size > 1000


def _textured_frames(shifts, W=1600, H=1200, seed=3, bg_factor=3):
    """Textured frames: noise plus shapes; the focus object moves by shifts and the background by bg_factor·dx,
    since on a Nimslo the far plane moves more than the near focus object."""
    rng = np.random.default_rng(seed)
    bg = cv2.GaussianBlur(rng.integers(0, 255, (H, W), np.uint8), (0, 0), 3)
    for _ in range(40):
        x, y = rng.integers(0, W), rng.integers(0, H)
        cv2.circle(bg, (int(x), int(y)), int(rng.integers(15, 60)), int(rng.integers(0, 255)), -1)
    frames, pts = [], []
    for dx, dy in shifts:
        im = cv2.cvtColor(bg, cv2.COLOR_GRAY2BGR).copy()
        im = np.roll(im, int(round(bg_factor * dx)), axis=1)
        cx, cy = 800 + dx, 600 + dy
        cv2.circle(im, (cx, cy), 60, (30, 160, 230), -1)
        cv2.line(im, (cx - 60, cy), (cx + 60, cy), (255, 255, 255), 3)
        cv2.line(im, (cx, cy - 60), (cx, cy + 60), (255, 255, 255), 3)
        im = cv2.convertScaleAbs(im, alpha=1.0 + 0.1 * dx / 90, beta=5 * dy)
        frames.append(im)
        pts.append((float(cx), float(cy)))
    return frames, pts


def test_match_point_finds_shifted_point_subpixel():
    shifts = [(-90, 6), (-30, -4), (30, 8), (90, -6)]
    frames, pts = _textured_frames(shifts)
    for i in range(1, 4):
        (x, y), score = processing.match_point(frames[0], frames[i], pts[0])
        assert abs(x - pts[i][0]) <= 1.0 and abs(y - pts[i][1]) <= 1.0, (i, x, y, pts[i])
        assert score > 0.7, score


def test_match_point_near_border_and_large_image():
    shifts = [(0, 0), (120, 10)]
    frames, pts = _textured_frames(shifts, W=3200, H=2400)
    edge = (40.0, 2380.0)
    (x, y), _ = processing.match_point(frames[0], frames[1], edge)
    assert 0 <= x < 3200 and 0 <= y < 2400


def test_suggest_point_lands_on_texture():
    frames, pts = _textured_frames([(0, 0)])
    im = np.full((1200, 1600, 3), 90, np.uint8)
    cv2.rectangle(im, (700, 500), (900, 700), (200, 200, 200), -1)
    x, y = processing.suggest_point(im)
    assert 680 <= x <= 920 and 480 <= y <= 720, (x, y)
    x2, y2 = processing.suggest_point(frames[0])
    assert 0 <= x2 < 1600 and 0 <= y2 < 1200


def test_estimate_order_recovers_shuffled_frames():
    shifts = [(-90, 6), (-30, -4), (30, 8), (90, -6)]
    frames, pts = _textured_frames(shifts, bg_factor=1.5)
    perm = [2, 0, 3, 1]
    shuffled = [frames[i] for i in perm]
    spts = [pts[i] for i in perm]
    res = processing.estimate_order(shuffled, spts)
    restored = [perm[i] for i in res["order"]]
    assert restored == [0, 1, 2, 3], (restored, res)
    assert res["direction_confident"] and res["confidence"] > 0.5, res
    res2 = processing.estimate_order(shuffled)
    restored2 = [perm[i] for i in res2["order"]]
    assert restored2 in ([0, 1, 2, 3], [3, 2, 1, 0]), restored2


def test_estimate_order_accepts_frames_of_slightly_different_sizes():
    shifts = [(-90, 6), (-30, -4), (30, 8), (90, -6)]
    frames, pts = _textured_frames(shifts, bg_factor=1.5)
    frames[2] = frames[2][:-6, :-10]
    res = processing.estimate_order(frames, pts)
    assert sorted(res["order"]) == [0, 1, 2, 3]


def test_color_signature_groups_similar_palettes():
    def flat(bgr: tuple[int, int, int]) -> np.ndarray:
        return np.full((60, 80, 3), bgr, dtype=np.uint8)

    red = processing.color_signature(flat((20, 30, 220)))
    darker_red = processing.color_signature(flat((10, 20, 180)))
    blue = processing.color_signature(flat((220, 40, 20)))
    assert len(red) == 6 + processing.HUE_BINS

    def dist(a: list[float], b: list[float]) -> float:
        return float(np.linalg.norm(np.asarray(a) - np.asarray(b)))

    assert dist(red, darker_red) < dist(red, blue)
    assert abs(sum(red[6:]) - 1.0) < 1e-3


def test_parallax_zoom_scales_about_the_focus_point():
    frames, points = make_frames()
    plain = processing.align_frames(frames, points)
    sizes = [(W, H)] * 4
    plan = processing.plan_frames(sizes, points)
    zoomed = [
        processing.warp_frame(im, off, plan, plan.alignment.targets[i], processing.parallax_scale(i, 4, 0.1))
        for i, (im, off) in enumerate(zip(frames, plan.alignment.offsets, strict=False))
    ]
    assert processing.parallax_scale(0, 4, 0.1) == 1.0 and processing.parallax_scale(3, 4, 0.1) == 1.1
    assert np.array_equal(zoomed[0], plain[0])
    for k in range(1, 4):
        assert np.allclose(centroid_of_white(zoomed[k]), centroid_of_white(plain[k]), atol=1.5)
    with pytest.raises(processing.ProcessingError, match="parallax_zoom"):
        processing.parallax_scale(1, 4, 0.5)


def test_transitions_blend_only_across_set_boundaries():
    pattern = [0, 1, 2, 3, 4, 5, 6, 7]
    items = processing.with_transitions(pattern, 4, 2)
    assert items[:4] == [(0, None, 0.0), (1, None, 0.0), (2, None, 0.0), (3, None, 0.0)]
    assert items[4:6] == [(3, 4, 1 / 3), (3, 4, 2 / 3)]
    assert items[-2:] == [(7, 0, 1 / 3), (7, 0, 2 / 3)]
    assert len(items) == 12
    assert processing.with_transitions(pattern, 4, 0) == [(f, None, 0.0) for f in pattern]
    sync = processing.composite_sequence(3, 4, "ends", "forward", 1, 10, 1, composition="double", loops=1)
    assert sync == [(0, None, 0.0), (3, None, 0.0)]


def test_compositions_produce_frames_of_the_output_size():
    def tinted(bgr: tuple[int, int, int]) -> np.ndarray:
        return np.full((60, 80, 3), bgr, dtype=np.uint8)

    frames = [tinted((0, 0, 200))] * 4 + [tinted((200, 0, 0))] * 4 + [tinted((0, 200, 0))] * 4
    double = processing.compose_frame(frames, (0, None, 0.0), "double", 4)
    assert double.shape == (60, 80, 3) and abs(int(double[0, 0, 0]) - 67) <= 1
    split = processing.compose_frame(frames[:8], (0, None, 0.0), "split", 4)
    assert tuple(split[0, 0]) == (0, 0, 200) and tuple(split[0, 79]) == (200, 0, 0)
    mosaic = processing.compose_frame(frames, (1, None, 0.0), "mosaic", 4)
    assert mosaic.shape == (60, 80, 3)
    assert tuple(mosaic[0, 0]) == (0, 0, 200) and tuple(mosaic[0, 79]) == (200, 0, 0) and tuple(mosaic[59, 0]) == (0, 200, 0)
    assert tuple(mosaic[59, 79]) == (0, 0, 0)
    triptych = processing.compose_frame(frames, (2, None, 0.0), "triptych", 4)
    assert triptych.shape == (60, 80, 3) and tuple(triptych[30, 40]) == (200, 0, 0)
    faded = processing.compose_frame(frames, (3, 4, 0.5), "crossfade", 4)
    assert tuple(faded[0, 0]) == (100, 0, 100)
    packed = [processing.to_i420(f) for f in frames]
    composed, indices = processing.compose_all(packed, [(0, None, 0.0), (1, None, 0.0), (0, None, 0.0)], "double", 4)
    assert len(composed) == 2 and indices == [0, 1, 0]
    assert composed[0].shape == packed[0].shape
    assert abs(int(processing.from_i420(composed[0])[0, 0, 0]) - 67) <= 2


def test_render_mosaic_with_zoom_and_crossfade(tmp_path: Path):
    first, first_points = make_frames()
    paths = []
    for i, f in enumerate(first + first):
        pth = tmp_path / f"f{i}.png"
        cv2.imwrite(str(pth), f)
        paths.append(pth)
    points = first_points + first_points
    info = processing.render(
        paths, points, tmp_path / "m.mp4", mode="ends", fps=6, duration=1, frames_per_set=4, composition="mosaic", parallax_zoom=0.05
    )
    assert info["frames"] == 6 and (tmp_path / "m.mp4").stat().st_size > 1000
    info = processing.render(
        paths,
        points,
        tmp_path / "c.mp4",
        mode="ends",
        fps=6,
        duration=1,
        frames_per_set=4,
        composition="crossfade",
        transition_frames=2,
        loops=1,
    )
    assert info["frames"] == 8


def test_structure_signature_groups_shots_of_the_same_scene():
    rng = np.random.default_rng(3)
    scene_a = rng.integers(0, 200, (60, 80, 3), dtype=np.uint8)
    scene_b = rng.integers(0, 255, (60, 80, 3), dtype=np.uint8)
    shifted_a = np.roll(scene_a, 2, axis=1)
    brighter_a = np.clip(scene_a.astype(np.int16) + 40, 0, 255).astype(np.uint8)

    def dist(a: list[float], b: list[float]) -> float:
        return float(np.linalg.norm(np.asarray(a) - np.asarray(b)))

    base = processing.structure_signature(scene_a)
    assert len(base) == processing.STRUCTURE_COLS * processing.STRUCTURE_ROWS
    assert dist(base, processing.structure_signature(shifted_a)) < dist(base, processing.structure_signature(scene_b))
    assert dist(base, processing.structure_signature(brighter_a)) < 1e-2


def test_tone_signature_reports_mean_and_spread_of_gray():
    flat = np.full((20, 30, 3), 100, dtype=np.uint8)
    mean, std = processing.tone_signature(flat)
    assert (mean, std) == (100.0, 0.0)
    brighter_mean, _ = processing.tone_signature(np.full((20, 30, 3), 160, dtype=np.uint8))
    assert brighter_mean > mean


def test_crop_from_fraction_stays_inside_the_area_and_even():
    area = (10, 20, 401, 301)
    assert processing.crop_from_fraction(area, (0.0, 0.0, 1.0, 1.0)) == (10, 20, 400, 300)
    x, y, w, h = processing.crop_from_fraction(area, (0.5, 0.5, 0.25, 0.25))
    assert (w, h) == (100, 74) and x == 210 and y == 170
    x, y, w, h = processing.crop_from_fraction(area, (0.9, 0.9, 0.5, 0.5))
    assert x + w <= 411 and y + h <= 321


def test_plan_frames_custom_preset_needs_a_crop():
    sizes = [(800, 600)] * 4
    pts = [(400.0, 300.0)] * 4
    with pytest.raises(processing.ProcessingError) as err:
        processing.plan_frames(sizes, pts, preset="custom")
    assert err.value.code == "crop_required"
    plan = processing.plan_frames(sizes, pts, preset="custom", crop_fraction=(0.25, 0.25, 0.5, 0.5), max_width=200)
    assert plan.crop[2:] == (400, 300)
    assert plan.out_size == (200, 150)


def test_split_rects_are_equal_and_symmetric():
    rects = processing.split_rects((4000, 1200), 4, "x", (0.05, 0.1, 0.9, 0.8), 0.01)
    widths = {w for _, _, w, _ in rects}
    heights = {h for _, _, _, h in rects}
    tops = {y for _, y, _, _ in rects}
    assert len(rects) == 4
    assert len(widths) == 1 and len(heights) == 1 and len(tops) == 1
    steps = {rects[k + 1][0] - rects[k][0] for k in range(3)}
    assert len(steps) == 1
    assert rects[0][0] == 200
    assert rects[-1][0] + rects[-1][2] <= 200 + 3600


def test_split_rects_along_y_and_too_small():
    rects = processing.split_rects((1200, 4000), 2, "y", (0.0, 0.0, 1.0, 1.0), 0.0)
    assert [r[1] for r in rects] == [0, 2000]
    assert all(r[2] == 1200 and r[3] == 2000 for r in rects)
    with pytest.raises(processing.ProcessingError) as info:
        processing.split_rects((200, 200), 4, "x", (0.0, 0.0, 1.0, 1.0), 0.0)
    assert info.value.code == "split_too_small"


def test_each_set_can_have_its_own_loop_and_repeats():
    loops = [processing.SetLoop("ends", None, 2), processing.SetLoop("custom", [1, 2], 1), processing.SetLoop("forward", None, 1)]
    assert processing.looped_series_pattern(4, "forward", loops) == [0, 3, 0, 3, 5, 6, 8, 9, 10, 11]
    assert processing.looped_series_pattern(4, "pingpong", loops) == [0, 3, 0, 3, 5, 6, 8, 9, 10, 11, 6, 5]
    assert processing.looped_series_pattern(4, "sweep", loops[:2]) == processing.loop_pattern(8, "ends")
    swing = processing.dwell_loops(4, "swing", 4, "pingpong", None)
    assert [loop.cycles for loop in swing] == [4, 3, 2, 1]
    assert processing.looped_series_pattern(4, "swing", swing) == processing.series_pattern(4, 4, "pingpong", "swing", 4)
    items = processing.composite_sequence(2, 4, "pingpong", "forward", 1, 8, 1, loops=1, composition="mosaic", set_loops=loops[:2])
    assert [item[0] for item in items] == [0, 3]
    with pytest.raises(processing.ProcessingError) as excinfo:
        processing.looped_series_pattern(4, "forward", [processing.SetLoop("ends", None, 5)])
    assert excinfo.value.code == "cycles_out_of_range"


def test_middle_loop_stays_symmetric_for_any_set_size():
    assert processing.loop_pattern(2, "middle") == [0, 1]
    assert processing.loop_pattern(3, "middle") == [0, 2]
    assert processing.loop_pattern(4, "middle") == [1, 2]
    assert processing.loop_pattern(5, "middle") == [1, 3]
    assert processing.loop_pattern(3, "pingpong") == [0, 1, 2, 1]
    assert processing.loop_pattern(2, "pingpong") == [0, 1]
