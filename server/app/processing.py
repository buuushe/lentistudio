from __future__ import annotations

import contextlib
import math
import shutil
import signal
import subprocess
from collections.abc import Callable, Iterable, Iterator, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

Point = tuple[float, float]
Size = tuple[int, int]


class ProcessingError(ValueError):
    def __init__(self, code: str, message: str, **params: object) -> None:
        super().__init__(message)
        self.code = code
        self.params = params


class EncodingError(RuntimeError):
    pass


def middle_pair(n: int) -> list[int]:
    if n < 4:
        return [0, n - 1]
    if n % 2:
        return [n // 2 - 1, n // 2 + 1]
    return [n // 2 - 1, n // 2]


LOOP_MODES = {
    "pingpong": lambda n: list(range(n)) + list(range(n - 2, 0, -1)),
    "pingpong_hold": lambda n: [0] + list(range(n)) + [n - 1] + list(range(n - 2, 0, -1)),
    "forward": lambda n: list(range(n)),
    "backward": lambda n: list(range(n - 1, -1, -1)),
    "ends": lambda n: [0, n - 1],
    "middle": lambda n: middle_pair(n),
    "custom": None,
}
MODES = tuple(LOOP_MODES)

SET_MODES = {
    "forward": lambda n: list(range(n)),
    "pingpong": lambda n: list(range(n)) + list(range(n - 2, 0, -1)),
    "forward_ease": lambda n: list(range(n)),
    "pingpong_ease": lambda n: list(range(n)) + list(range(n - 2, 0, -1)),
    "swing": lambda n: list(range(n)) + list(range(n - 2, 0, -1)),
    "sweep": lambda n: list(range(n)),
}
SWEEP_SET_MODE = "sweep"
MAX_CYCLES_PER_SET = 4
MAX_LOOPS = 4

CROP_PRESETS: dict[str, Size | None] = {
    "free": None,
    "ig_portrait": (1080, 1350),
    "ig_square": (1080, 1080),
    "ig_story": (1080, 1920),
    "ig_landscape": (1080, 566),
    "custom": None,
}

CropFraction = tuple[float, float, float, float]
MIN_CROP_FRACTION = 0.05


def crop_from_fraction(area: tuple[int, int, int, int], fraction: CropFraction) -> tuple[int, int, int, int]:
    bx, by, bw, bh = area
    fx, fy, fw, fh = fraction
    nw = min(_even_floor(bw), max(2, _even_floor(int(round(bw * max(fw, MIN_CROP_FRACTION))))))
    nh = min(_even_floor(bh), max(2, _even_floor(int(round(bh * max(fh, MIN_CROP_FRACTION))))))
    nx = min(max(int(round(bx + bw * fx)), bx), bx + bw - nw)
    ny = min(max(int(round(by + bh * fy)), by), by + bh - nh)
    return nx, ny, nw, nh


Rect = tuple[int, int, int, int]
SPLIT_COUNTS = (2, 3, 4)
MIN_SPLIT_CELL = 64


def split_rects(size: Size, count: int, axis: str, box: CropFraction, gap: float) -> list[Rect]:
    width, height = size
    fx, fy, fw, fh = box
    bx = min(max(int(round(fx * width)), 0), width - 1)
    by = min(max(int(round(fy * height)), 0), height - 1)
    bw = min(max(int(round(fw * width)), 1), width - bx)
    bh = min(max(int(round(fh * height)), 1), height - by)
    along = bw if axis == "x" else bh
    gap_px = int(round(gap * (width if axis == "x" else height)))
    cell = (along - gap_px * (count - 1)) // count
    if cell < MIN_SPLIT_CELL or (bh if axis == "x" else bw) < MIN_SPLIT_CELL:
        raise ProcessingError("split_too_small", "The frames would be smaller than the minimum size", minSide=MIN_SPLIT_CELL)
    step = cell + gap_px
    if axis == "x":
        return [(bx + k * step, by, cell, bh) for k in range(count)]
    return [(bx, by + k * step, bw, cell) for k in range(count)]


SHARPEN_STRENGTH = 0.25
SHARPEN_KERNEL = np.array(
    [
        [0.0, -SHARPEN_STRENGTH, 0.0],
        [-SHARPEN_STRENGTH, 1.0 + 4.0 * SHARPEN_STRENGTH, -SHARPEN_STRENGTH],
        [0.0, -SHARPEN_STRENGTH, 0.0],
    ],
    dtype=np.float32,
)
SHARPEN_MAX = 3


@dataclass(frozen=True)
class Adjust:
    brightness: float = 0.0
    contrast: float = 0.0
    sharpen: int = 0

    def is_identity(self) -> bool:
        return self.brightness == 0 and self.contrast == 0 and self.sharpen == 0


def apply_adjust(img: np.ndarray, adj: Adjust) -> np.ndarray:
    if adj.is_identity():
        return img
    if not (0 <= adj.sharpen <= SHARPEN_MAX):
        raise ProcessingError("sharpen_out_of_range", f"sharpen must be within 0..{SHARPEN_MAX}", max=SHARPEN_MAX)

    out = img
    if adj.brightness != 0 or adj.contrast != 0:
        k = 1.0 + max(-100.0, min(100.0, adj.contrast)) / 100.0
        b = max(-100.0, min(100.0, adj.brightness)) * 1.27
        x = np.arange(256, dtype=np.float32)
        lut = np.clip((x - 128.0) * k + 128.0 + b, 0, 255).astype(np.uint8)
        out = cv2.LUT(out, lut)
    for _ in range(int(adj.sharpen)):
        out = cv2.filter2D(out, -1, SHARPEN_KERNEL, borderType=cv2.BORDER_REPLICATE)
    return out


@dataclass(frozen=True)
class Alignment:
    offsets: list[Point]
    crop: tuple[int, int, int, int]
    target: Point
    targets: list[Point]


def _even_floor(v: int) -> int:
    return v if v % 2 == 0 else v - 1


def focus_targets(pts: np.ndarray, frames_per_set: int | None, shared_focus: bool) -> np.ndarray:
    n = len(pts)
    if shared_focus or not frames_per_set or n % frames_per_set:
        return np.repeat(pts.mean(axis=0)[None, :], n, axis=0)
    grouped = pts.reshape(n // frames_per_set, frames_per_set, 2)
    per_set = grouped.mean(axis=1)
    return np.repeat(per_set, frames_per_set, axis=0)


def compute_alignment(
    sizes: Sequence[Size],
    points: Sequence[Point],
    frames_per_set: int | None = None,
    shared_focus: bool = True,
) -> Alignment:
    if len(sizes) != len(points) or len(sizes) < 2:
        raise ProcessingError("points_mismatch", "At least 2 frames are required and every frame needs a point")

    pts = np.asarray(points, dtype=np.float64)
    targets = focus_targets(pts, frames_per_set, shared_focus)
    target = np.unique(targets, axis=0).mean(axis=0)
    offsets = targets - pts

    x0 = max(float(np.ceil(o[0])) for o in offsets)
    y0 = max(float(np.ceil(o[1])) for o in offsets)
    x1 = min(float(np.floor(o[0] + s[0])) for o, s in zip(offsets, sizes, strict=False))
    y1 = min(float(np.floor(o[1] + s[1])) for o, s in zip(offsets, sizes, strict=False))

    w = _even_floor(int(x1 - x0))
    h = _even_floor(int(y1 - y0))
    if w < 2 or h < 2:
        raise ProcessingError("no_overlap", "Frames do not overlap after alignment, check the focus points")

    return Alignment(
        offsets=[(float(o[0]), float(o[1])) for o in offsets],
        crop=(int(x0), int(y0), w, h),
        target=(float(target[0]), float(target[1])),
        targets=[(float(t[0]), float(t[1])) for t in targets],
    )


def fit_aspect(
    crop: tuple[int, int, int, int],
    aspect: float | None,
    anchor: Point | None = None,
) -> tuple[int, int, int, int]:
    cx, cy, cw, ch = crop
    if aspect is None:
        return crop
    if cw / ch > aspect:
        nh = ch
        nw = _even_floor(int(ch * aspect))
    else:
        nw = cw
        nh = _even_floor(int(cw / aspect))
    if nw < 2 or nh < 2:
        raise ProcessingError("common_area_too_small", "The common area is too small for the selected format")

    ax, ay = anchor if anchor is not None else (cx + cw / 2, cy + ch / 2)
    nx = int(round(ax - nw / 2))
    ny = int(round(ay - nh / 2))
    nx = min(max(nx, cx), cx + cw - nw)
    ny = min(max(ny, cy), cy + ch - nh)
    return nx, ny, nw, nh


def _fit_width(w: int, h: int, max_width: int | None) -> Size:
    if not max_width or w <= max_width:
        return w, h
    scale = max_width / w
    nw = _even_floor(max(2, int(round(w * scale))))
    nh = _even_floor(max(2, int(round(h * scale))))
    return nw, nh


@dataclass(frozen=True)
class FramePlan:
    alignment: Alignment
    crop: tuple[int, int, int, int]
    out_size: Size


def plan_frames(
    sizes: Sequence[Size],
    points: Sequence[Point],
    max_width: int | None = None,
    preset: str = "free",
    anchor_frac: Point | None = None,
    frames_per_set: int | None = None,
    shared_focus: bool = True,
    crop_fraction: CropFraction | None = None,
) -> FramePlan:
    if preset not in CROP_PRESETS:
        raise ProcessingError("unknown_preset", f"Unknown crop preset: {preset}", preset=preset)
    al = compute_alignment(sizes, points, frames_per_set, shared_focus)
    target_size = CROP_PRESETS[preset]
    if preset == "custom":
        if crop_fraction is None:
            raise ProcessingError("crop_required", "The custom preset needs a crop rectangle")
        crop = crop_from_fraction(al.crop, crop_fraction)
        out_size = _fit_width(crop[2], crop[3], max_width)
    elif target_size is None:
        crop = al.crop
        out_size = _fit_width(crop[2], crop[3], max_width)
    else:
        bx, by, bw, bh = al.crop
        anchor = al.target if anchor_frac is None else (bx + bw * float(anchor_frac[0]), by + bh * float(anchor_frac[1]))
        crop = fit_aspect(al.crop, target_size[0] / target_size[1], anchor)
        out_size = target_size
    return FramePlan(alignment=al, crop=crop, out_size=out_size)


MAX_PARALLAX_ZOOM = 0.2


def parallax_scale(position: int, frames_per_set: int, zoom: float) -> float:
    if not (0 <= zoom <= MAX_PARALLAX_ZOOM):
        raise ProcessingError("zoom_out_of_range", f"parallax_zoom must be within 0..{MAX_PARALLAX_ZOOM}", max=MAX_PARALLAX_ZOOM)
    if frames_per_set < 2 or zoom == 0:
        return 1.0
    return 1.0 + zoom * position / (frames_per_set - 1)


def warp_frame(
    im: np.ndarray,
    offset: Point,
    plan: FramePlan,
    focus: Point | None = None,
    scale: float = 1.0,
) -> np.ndarray:
    cx, cy, cw, ch = plan.crop
    fx, fy = (focus[0] - cx, focus[1] - cy) if focus is not None else (cw / 2, ch / 2)
    m = np.array(
        [
            [scale, 0.0, scale * (offset[0] - cx) + (1.0 - scale) * fx],
            [0.0, scale, scale * (offset[1] - cy) + (1.0 - scale) * fy],
        ],
        dtype=np.float64,
    )
    warped = cv2.warpAffine(im, m, (cw, ch), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    nw, nh = plan.out_size
    if (nw, nh) == (cw, ch):
        return warped
    interp = cv2.INTER_AREA if nw < cw else cv2.INTER_LANCZOS4
    return cv2.resize(warped, (nw, nh), interpolation=interp)


def image_size(im: np.ndarray) -> Size:
    return int(im.shape[1]), int(im.shape[0])


def align_frames(
    images: Sequence[np.ndarray],
    points: Sequence[Point],
    max_width: int | None = None,
    preset: str = "free",
    anchor_frac: Point | None = None,
) -> list[np.ndarray]:
    plan = plan_frames([image_size(im) for im in images], points, max_width, preset, anchor_frac)
    return [warp_frame(im, offset, plan) for im, offset in zip(images, plan.alignment.offsets, strict=False)]


def too_large(frame_count: int, out_size: Size, **limits: object) -> ProcessingError:
    return ProcessingError(
        "too_large",
        "Too many frames for this output size, lower the width or the number of sets",
        frames=frame_count,
        width=out_size[0],
        height=out_size[1],
        **limits,
    )


def ensure_render_fits(frame_count: int, out_size: Size, max_pixels: int | None) -> None:
    total = frame_count * out_size[0] * out_size[1]
    if max_pixels and total > max_pixels:
        raise too_large(frame_count, out_size, max_pixels=max_pixels)


def loop_pattern(n_frames: int, mode: str, custom: Sequence[int] | None = None) -> list[int]:
    if mode not in LOOP_MODES:
        raise ProcessingError("unknown_mode", f"mode must be one of {MODES}", mode=mode)
    if n_frames < 2:
        raise ProcessingError("too_few_frames", "At least 2 frames are required")
    if mode == "custom":
        if not custom:
            raise ProcessingError("pattern_required", "The custom mode requires a frame pattern")
        pattern = [int(i) for i in custom]
        if any(i < 0 or i >= n_frames for i in pattern):
            raise ProcessingError("pattern_out_of_range", f"The pattern may only contain frames 1..{n_frames}", frames=n_frames)
        if len(set(pattern)) < 2:
            raise ProcessingError("pattern_needs_two_frames", "The pattern must contain at least two different frames")
        return pattern
    return LOOP_MODES[mode](n_frames)


def set_pattern(set_count: int, set_mode: str) -> list[int]:
    if set_mode not in SET_MODES:
        raise ProcessingError("unknown_set_mode", f"set_mode must be one of {tuple(SET_MODES)}", set_mode=set_mode)
    if set_count < 1:
        raise ProcessingError("too_few_sets", "At least one set of frames is required")
    return SET_MODES[set_mode](set_count)


def edge_dwell(set_index: int, set_count: int, max_cycles: int) -> int:
    if set_count < 2:
        return max_cycles
    edge_distance = min(set_index, set_count - 1 - set_index) / (set_count - 1)
    weight = 0.5 + 0.5 * math.cos(2 * math.pi * edge_distance)
    return 1 + int(math.floor((max_cycles - 1) * weight + 0.5 + 1e-9))


def left_dwell(set_index: int, set_count: int, max_cycles: int) -> int:
    if set_count < 2:
        return max_cycles
    weight = 1 - set_index / (set_count - 1)
    return 1 + int(math.floor((max_cycles - 1) * weight + 0.5 + 1e-9))


def constant_dwell(_: int, __: int, max_cycles: int) -> int:
    return max_cycles


SET_DWELL = {
    "forward_ease": edge_dwell,
    "pingpong_ease": edge_dwell,
    "swing": left_dwell,
}


@dataclass(frozen=True)
class SetLoop:
    mode: str = "pingpong"
    custom: Sequence[int] | None = None
    cycles: int = 1


def check_cycles(cycles: int) -> None:
    if not (1 <= cycles <= MAX_CYCLES_PER_SET):
        raise ProcessingError("cycles_out_of_range", f"cycles_per_set must be within 1..{MAX_CYCLES_PER_SET}", max=MAX_CYCLES_PER_SET)


def dwell_loops(set_count: int, set_mode: str, cycles_per_set: int, mode: str, custom: Sequence[int] | None) -> list[SetLoop]:
    check_cycles(cycles_per_set)
    dwell = SET_DWELL.get(set_mode, constant_dwell)
    return [SetLoop(mode, custom, dwell(set_index, set_count, cycles_per_set)) for set_index in range(set_count)]


BOUNCING_SET_MODES = {"pingpong", "pingpong_ease", "swing"}


def is_return_visit(set_mode: str, visit: int, set_count: int) -> bool:
    return set_mode in BOUNCING_SET_MODES and visit >= set_count


def looped_series_pattern(frames_per_set: int, set_mode: str, set_loops: Sequence[SetLoop]) -> list[int]:
    set_count = len(set_loops)
    order = set_pattern(set_count, set_mode)
    if set_mode == SWEEP_SET_MODE:
        first = set_loops[0]
        strip_mode = "pingpong" if first.mode == "custom" else first.mode
        return loop_pattern(set_count * frames_per_set, strip_mode)
    frame_patterns = []
    for loop in set_loops:
        check_cycles(loop.cycles)
        frame_patterns.append(loop_pattern(frames_per_set, loop.mode, loop.custom))
    pattern: list[int] = []
    for visit, set_index in enumerate(order):
        frames = frame_patterns[set_index]
        if is_return_visit(set_mode, visit, set_count):
            frames = frames[::-1]
        for _ in range(set_loops[set_index].cycles):
            pattern.extend(set_index * frames_per_set + frame for frame in frames)
    return pattern


def series_pattern(
    set_count: int,
    frames_per_set: int,
    mode: str,
    set_mode: str = "forward",
    cycles_per_set: int = 1,
    custom: Sequence[int] | None = None,
) -> list[int]:
    if set_mode == SWEEP_SET_MODE:
        strip_mode = "pingpong" if mode == "custom" else mode
        return loop_pattern(set_count * frames_per_set, strip_mode)
    return looped_series_pattern(frames_per_set, set_mode, dwell_loops(set_count, set_mode, cycles_per_set, mode, custom))


def repeat_to_fill(pattern: list[int], fps: int, duration: float, loops: int | None = None) -> list[int]:
    if loops is not None:
        if not (1 <= loops <= MAX_LOOPS):
            raise ProcessingError("loops_out_of_range", f"loops must be within 1..{MAX_LOOPS}", max=MAX_LOOPS)
        return pattern * loops
    total = max(len(pattern), int(round(fps * duration)))
    reps = max(1, total // len(pattern))
    return pattern * reps


COMPOSITIONS = ("single", "crossfade", "double", "split", "mosaic", "triptych")
SYNC_COMPOSITIONS = {"double", "split", "mosaic", "triptych"}
MAX_TRANSITION_FRAMES = 8

Composite = tuple[int, int | None, float]


def with_transitions(pattern: Sequence[int], frames_per_set: int, transition_frames: int) -> list[Composite]:
    if not (0 <= transition_frames <= MAX_TRANSITION_FRAMES):
        raise ProcessingError(
            "transition_out_of_range", f"transition_frames must be within 0..{MAX_TRANSITION_FRAMES}", max=MAX_TRANSITION_FRAMES
        )
    items: list[Composite] = []
    for k, frame in enumerate(pattern):
        items.append((frame, None, 0.0))
        following = pattern[(k + 1) % len(pattern)]
        if transition_frames and frame // frames_per_set != following // frames_per_set:
            items.extend((frame, following, step / (transition_frames + 1)) for step in range(1, transition_frames + 1))
    return items


def composite_sequence(
    set_count: int,
    frames_per_set: int,
    mode: str,
    set_mode: str,
    cycles_per_set: int,
    fps: int,
    duration: float,
    custom: Sequence[int] | None = None,
    loops: int | None = None,
    composition: str = "single",
    transition_frames: int = 0,
    set_loops: Sequence[SetLoop] | None = None,
) -> list[Composite]:
    if composition not in COMPOSITIONS:
        raise ProcessingError("unknown_composition", f"composition must be one of {COMPOSITIONS}", composition=composition)
    if set_loops is not None and len(set_loops) != set_count:
        raise ProcessingError("set_loops_mismatch", "There must be one loop per set of frames")
    if composition in SYNC_COMPOSITIONS:
        first = set_loops[0] if set_loops else SetLoop(mode, custom)
        pattern = loop_pattern(frames_per_set, first.mode, first.custom)
        items: list[Composite] = [(position, None, 0.0) for position in pattern]
    else:
        if set_loops:
            pattern = looped_series_pattern(frames_per_set, set_mode, set_loops)
        else:
            pattern = series_pattern(set_count, frames_per_set, mode, set_mode, cycles_per_set, custom)
        items = with_transitions(pattern, frames_per_set, transition_frames if composition == "crossfade" else 0)
    return repeat_to_fill(items, fps, duration, loops)  # type: ignore[arg-type]


def blend(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    return cv2.addWeighted(a, 1.0 - t, b, t, 0.0)


def cover_resize(img: np.ndarray, width: int, height: int) -> np.ndarray:
    h, w = img.shape[:2]
    scale = max(width / w, height / h)
    rw, rh = max(width, int(round(w * scale))), max(height, int(round(h * scale)))
    resized = cv2.resize(img, (rw, rh), interpolation=cv2.INTER_AREA if rw < w else cv2.INTER_LINEAR)
    x0, y0 = (rw - width) // 2, (rh - height) // 2
    return resized[y0 : y0 + height, x0 : x0 + width]


def mosaic_grid(set_count: int, single_row: bool) -> tuple[int, int]:
    if single_row:
        return set_count, 1
    cols = int(math.ceil(math.sqrt(set_count)))
    rows = int(math.ceil(set_count / cols))
    return cols, rows


def compose_frame(frames: Sequence[np.ndarray], item: Composite, composition: str, frames_per_set: int) -> np.ndarray:
    a, b, t = item
    if composition not in SYNC_COMPOSITIONS:
        return frames[a] if b is None else blend(frames[a], frames[b], t)
    set_count = len(frames) // frames_per_set
    at_position = [frames[k * frames_per_set + a] for k in range(set_count)]
    h, w = at_position[0].shape[:2]
    if composition == "double":
        total = np.zeros(at_position[0].shape, dtype=np.float32)
        for f in at_position:
            total += f
        return np.clip(total / len(at_position) + 0.5, 0, 255).astype(np.uint8)
    if composition == "split":
        bounds = [round(w * k / set_count) for k in range(set_count + 1)]
        return np.hstack([f[:, bounds[k] : bounds[k + 1]] for k, f in enumerate(at_position)])
    cols, rows = mosaic_grid(set_count, composition == "triptych")
    cell_w, cell_h = w // cols, h // rows
    canvas = np.zeros((cell_h * rows, cell_w * cols, 3), dtype=np.uint8)
    for k, f in enumerate(at_position):
        col, row = k % cols, k // cols
        canvas[row * cell_h : (row + 1) * cell_h, col * cell_w : (col + 1) * cell_w] = cover_resize(f, cell_w, cell_h)
    if canvas.shape[:2] != (h, w):
        canvas = cv2.resize(canvas, (w, h), interpolation=cv2.INTER_LINEAR)
    return canvas


I420_BYTES_PER_PIXEL = 1.5


def to_i420(bgr: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2YUV_I420)


def from_i420(yuv: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_I420)


class BgrView(Sequence[np.ndarray]):
    def __init__(self, i420_frames: Sequence[np.ndarray]):
        self._frames = i420_frames

    def __len__(self) -> int:
        return len(self._frames)

    def __getitem__(self, index: int) -> np.ndarray:
        return from_i420(self._frames[index])


def compose_all(
    frames: Sequence[np.ndarray], items: Sequence[Composite], composition: str, frames_per_set: int
) -> tuple[list[np.ndarray], list[int]]:
    synced = composition in SYNC_COMPOSITIONS
    source = BgrView(frames) if synced else frames
    distinct: dict[Composite, int] = {}
    composed: list[np.ndarray] = []
    indices: list[int] = []
    for item in items:
        if item not in distinct:
            distinct[item] = len(composed)
            frame = compose_frame(source, item, composition, frames_per_set)
            composed.append(to_i420(frame) if synced else frame)
        indices.append(distinct[item])
    return composed, indices


def new_composite_count(items: Sequence[Composite], composition: str) -> int:
    distinct = set(items)
    if composition in SYNC_COMPOSITIONS:
        return len(distinct)
    return sum(1 for _, b, _ in distinct if b is not None)


MATCH_COARSE_WIDTH = 800
MATCH_PATCH_FRAC = 0.07
MATCH_FINE_RADIUS = 12


def _gray(img: np.ndarray) -> np.ndarray:
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def _template_at(gray: np.ndarray, pt: Point, size: int) -> tuple[np.ndarray, tuple[float, float]]:
    h, w = gray.shape
    size = int(max(8, min(size, w, h)))
    x0 = int(round(min(max(pt[0] - size / 2, 0), w - size)))
    y0 = int(round(min(max(pt[1] - size / 2, 0), h - size)))
    return gray[y0 : y0 + size, x0 : x0 + size], (pt[0] - x0, pt[1] - y0)


def _subpixel_peak(res: np.ndarray, loc: tuple[int, int]) -> tuple[float, float]:
    x, y = loc
    dx = dy = 0.0
    if 0 < x < res.shape[1] - 1:
        left, center, right = float(res[y, x - 1]), float(res[y, x]), float(res[y, x + 1])
        den = left - 2 * center + right
        if den < 0:
            dx = max(-0.5, min(0.5, 0.5 * (left - right) / den))
    if 0 < y < res.shape[0] - 1:
        u, center, d = float(res[y - 1, x]), float(res[y, x]), float(res[y + 1, x])
        den = u - 2 * center + d
        if den < 0:
            dy = max(-0.5, min(0.5, 0.5 * (u - d) / den))
    return x + dx, y + dy


def match_point(ref: np.ndarray, target: np.ndarray, pt: Point) -> tuple[Point, float]:
    g_ref, g_tgt = _gray(ref), _gray(target)
    h, w = g_ref.shape
    patch = int(round(w * MATCH_PATCH_FRAC))

    s = min(1.0, MATCH_COARSE_WIDTH / w)
    if s < 1.0:
        r_s = cv2.resize(g_ref, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        t_s = cv2.resize(g_tgt, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    else:
        r_s, t_s = g_ref, g_tgt
    tpl, off = _template_at(r_s, (pt[0] * s, pt[1] * s), int(round(patch * s)))
    res = cv2.matchTemplate(t_s, tpl, cv2.TM_CCOEFF_NORMED)
    _, _, _, loc = cv2.minMaxLoc(res)
    coarse = ((loc[0] + off[0]) / s, (loc[1] + off[1]) / s)

    tpl, off = _template_at(g_ref, pt, patch)
    th, tw = tpl.shape
    rad = MATCH_FINE_RADIUS + (int(round(1 / s)) if s < 1.0 else 0)
    x0 = int(max(0, round(coarse[0] - off[0]) - rad))
    y0 = int(max(0, round(coarse[1] - off[1]) - rad))
    x1 = int(min(g_tgt.shape[1], round(coarse[0] - off[0]) + tw + rad))
    y1 = int(min(g_tgt.shape[0], round(coarse[1] - off[1]) + th + rad))
    region = g_tgt[y0:y1, x0:x1]
    if region.shape[0] < th or region.shape[1] < tw:
        return coarse, float(res.max())
    res2 = cv2.matchTemplate(region, tpl, cv2.TM_CCOEFF_NORMED)
    _, score, _, loc2 = cv2.minMaxLoc(res2)
    fx, fy = _subpixel_peak(res2, loc2)
    found = (x0 + fx + off[0], y0 + fy + off[1])
    found = (min(max(found[0], 0.0), w - 1.0), min(max(found[1], 0.0), h - 1.0))
    return found, float(max(0.0, min(1.0, score)))


def suggest_point(img: np.ndarray, center_frac: float = 0.5) -> Point:
    g = _gray(img)
    h, w = g.shape
    s = min(1.0, MATCH_COARSE_WIDTH / w)
    gs = cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1.0 else g
    hs, ws = gs.shape
    mask = np.zeros_like(gs)
    mx, my = int(ws * (1 - center_frac) / 2), int(hs * (1 - center_frac) / 2)
    mask[my : hs - my, mx : ws - mx] = 255
    corners = cv2.goodFeaturesToTrack(gs, maxCorners=40, qualityLevel=0.02, minDistance=int(ws * 0.03), mask=mask, blockSize=7)
    if corners is None or len(corners) == 0:
        return (w / 2.0, h / 2.0)
    pts = corners.reshape(-1, 2)
    cx, cy = ws / 2.0, hs / 2.0
    maxd = float(np.hypot(cx, cy))
    best, best_score = None, -1.0
    for rank, (x, y) in enumerate(pts):
        quality = 1.0 - rank / max(1, len(pts))
        closeness = 1.0 - float(np.hypot(x - cx, y - cy)) / maxd
        sc = 0.6 * quality + 0.4 * closeness
        if sc > best_score:
            best, best_score = (x, y), sc
    assert best is not None
    return (float(best[0]) / s, float(best[1]) / s)


def estimate_order(images: Sequence[np.ndarray], points: Sequence[Point] | None = None) -> dict:
    n = len(images)
    if n < 2:
        raise ProcessingError("too_few_frames", "At least 2 frames are required")
    grays = [_gray(im) for im in images]
    h, w = grays[0].shape
    s = min(1.0, MATCH_COARSE_WIDTH / w)
    small = [cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1.0 else g for g in grays]
    ref = small[0]
    size = (ref.shape[1], ref.shape[0])
    small = [im if im.shape == ref.shape else cv2.resize(im, size, interpolation=cv2.INTER_AREA) for im in small]

    corners = cv2.goodFeaturesToTrack(ref, maxCorners=300, qualityLevel=0.01, minDistance=int(ref.shape[1] * 0.02), blockSize=7)
    if corners is None or len(corners) < 8:
        raise ProcessingError("too_few_features", "Not enough detail to track between frames")
    p0 = corners.astype(np.float32)

    lk = dict(winSize=(31, 31), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01))
    dx = np.zeros((len(p0), n), dtype=np.float64)
    ok = np.ones(len(p0), dtype=bool)
    ref_f = np.float32(ref)
    for i in range(1, n):
        (gx, gy), _ = cv2.phaseCorrelate(ref_f, np.float32(small[i]))
        init = (p0.reshape(-1, 2) + np.float32([gx, gy])).reshape(-1, 1, 2).astype(np.float32)
        p1, st, _ = cv2.calcOpticalFlowPyrLK(ref, small[i], p0, init, flags=cv2.OPTFLOW_USE_INITIAL_FLOW, **lk)
        init_back = (p1.reshape(-1, 2) - np.float32([gx, gy])).reshape(-1, 1, 2).astype(np.float32)
        p0b, st_b, _ = cv2.calcOpticalFlowPyrLK(small[i], ref, p1, init_back, flags=cv2.OPTFLOW_USE_INITIAL_FLOW, **lk)
        fb = np.linalg.norm((p0b - p0).reshape(-1, 2), axis=1)
        good = (st.ravel() == 1) & (st_b.ravel() == 1) & (fb < 1.0)
        ok &= good
        dx[:, i] = (p1.reshape(-1, 2)[:, 0] - p0.reshape(-1, 2)[:, 0]) / s
    dx = dx[ok]
    if len(dx) < 8:
        raise ProcessingError("tracking_failed", "Could not reliably track features between frames")

    rel = dx - np.median(dx, axis=0, keepdims=True)
    _, sv, vt = np.linalg.svd(rel, full_matrices=False)
    t = vt[0]
    scale = float(np.abs(rel).max()) if rel.size else 0.0
    energy = float(sv[0] ** 2 / max(1e-9, (sv**2).sum()))
    confidence = energy * min(1.0, scale / 8.0)

    direction_confident = False
    if points is not None and len(points) == n:
        focus_dx = np.array([points[i][0] - points[0][0] for i in range(n)])
        rel_focus = dx - focus_dx[None, :]
        corr = float(np.median(rel_focus, axis=0) @ t)
        if abs(corr) > 1e-6:
            if corr < 0:
                t = -t
            direction_confident = True
    else:
        if t[0] > t.mean():
            t = -t

    order = [int(i) for i in np.argsort(t, kind="stable")]
    return {
        "order": order,
        "t": [float(v) for v in t],
        "confidence": round(max(0.0, min(1.0, confidence)), 3),
        "direction_confident": direction_confident,
        "tracked": int(len(dx)),
        "parallax_px": round(scale, 1),
    }


ENCODER_THREADS = 2
ENCODER_LOOKAHEAD = 20


def find_ffmpeg() -> str:
    path = shutil.which("ffmpeg") or shutil.which("ffmpeg", path="/opt/homebrew/bin:/usr/local/bin")
    if not path:
        raise EncodingError("ffmpeg was not found in PATH")
    return path


PIXEL_FORMATS = ("bgr24", "yuv420p")


def frame_shape(size: Size, pix_fmt: str) -> tuple[int, ...]:
    w, h = size
    return (h, w, 3) if pix_fmt == "bgr24" else (h * 3 // 2, w)


def frame_size(frame: np.ndarray, pix_fmt: str) -> Size:
    h, w = frame.shape[:2]
    return (w, h) if pix_fmt == "bgr24" else (w, h * 2 // 3)


def encode_mp4(
    frames: Sequence[np.ndarray],
    sequence: Iterable[int],
    fps: int,
    out_path: Path | str,
    crf: int = 18,
    pix_fmt: str = "bgr24",
) -> Path:
    size = frame_size(frames[0], pix_fmt)
    return encode_frame_stream((frames[index] for index in sequence), size, fps, out_path, crf, pix_fmt)


def encode_frame_stream(
    frames: Iterable[np.ndarray],
    size: Size,
    fps: int,
    out_path: Path | str,
    crf: int = 18,
    pix_fmt: str = "bgr24",
) -> Path:
    if pix_fmt not in PIXEL_FORMATS:
        raise ProcessingError("unknown_pixel_format", f"pix_fmt must be one of {PIXEL_FORMATS}", pix_fmt=pix_fmt)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    w, h = size
    expected_shape = frame_shape(size, pix_fmt)

    cmd = [
        find_ffmpeg(),
        "-y",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        pix_fmt,
        "-s",
        f"{w}x{h}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        str(crf),
        "-threads",
        str(ENCODER_THREADS),
        "-rc-lookahead",
        str(ENCODER_LOOKAHEAD),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None and proc.stderr is not None
    try:
        for frame in frames:
            if frame.shape != expected_shape:
                raise ProcessingError("frame_size_mismatch", f"All frames must be {pix_fmt} images of the same size")
            proc.stdin.write(memoryview(np.ascontiguousarray(frame)).cast("B"))
        proc.stdin.flush()
    except BrokenPipeError:
        pass
    except Exception:
        with contextlib.suppress(BrokenPipeError, OSError):
            proc.stdin.close()
        proc.kill()
        proc.wait()
        raise
    with contextlib.suppress(BrokenPipeError, OSError):
        proc.stdin.close()
    err = proc.stderr.read()
    proc.wait()
    if proc.returncode == -signal.SIGKILL:
        raise EncodingError("ffmpeg was killed, most likely out of memory")
    if proc.returncode != 0:
        raise EncodingError(f"ffmpeg failed: {err.decode(errors='replace')}")
    return out_path


def read_image(path: Path | str) -> np.ndarray:
    im = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if im is None:
        raise ProcessingError("unreadable_image", f"Could not read image: {path}", path=str(path))
    return im


def read_sizes(image_paths: Sequence[Path | str]) -> list[Size]:
    return [image_size(read_image(path)) for path in image_paths]


ENCODER_BASE_BYTES = 60 * 1024 * 1024
ENCODER_BYTES_PER_PIXEL = 150
BGR_BYTES_PER_PIXEL = 3
FLOAT_BGR_BYTES_PER_PIXEL = 12


def estimate_render_bytes(sizes: Sequence[Size], plan: FramePlan, items: Sequence[Composite], composition: str, set_count: int) -> int:
    out_pixels = plan.out_size[0] * plan.out_size[1]
    packed = I420_BYTES_PER_PIXEL * out_pixels * (len(sizes) + new_composite_count(items, composition))
    source_pixels = max(w * h for w, h in sizes)
    warping = BGR_BYTES_PER_PIXEL * (2 * source_pixels + plan.crop[2] * plan.crop[3] + out_pixels)
    composing = 0
    if composition in SYNC_COMPOSITIONS:
        accumulator = FLOAT_BGR_BYTES_PER_PIXEL if composition == "double" else 0
        composing = out_pixels * (BGR_BYTES_PER_PIXEL * (set_count + 1) + accumulator)
    encoding = ENCODER_BASE_BYTES + ENCODER_BYTES_PER_PIXEL * out_pixels
    return int(packed + max(warping, composing, encoding))


def render(
    image_paths: Sequence[Path | str],
    points: Sequence[Point],
    out_path: Path | str,
    mode: str = "pingpong",
    fps: int = 10,
    duration: float = 6.0,
    max_width: int | None = None,
    preset: str = "free",
    anchor_frac: Point | None = None,
    adjustments: Sequence[Adjust] | None = None,
    custom_pattern: Sequence[int] | None = None,
    frames_per_set: int | None = None,
    set_mode: str = "forward",
    cycles_per_set: int = 1,
    max_pixels: int | None = None,
    shared_focus: bool = True,
    loops: int | None = None,
    composition: str = "single",
    transition_frames: int = 0,
    parallax_zoom: float = 0.0,
    crop_fraction: CropFraction | None = None,
    set_loops: Sequence[SetLoop] | None = None,
    reserve_memory: Callable[[int], AbstractContextManager[object]] | None = None,
) -> dict:
    if adjustments is not None and len(adjustments) != len(image_paths):
        raise ProcessingError("adjustments_mismatch", "The number of adjustments must match the number of frames")
    per_set = frames_per_set or len(image_paths)
    if per_set < 2 or len(image_paths) % per_set:
        raise ProcessingError("frames_not_grouped", f"The number of frames must be a multiple of {per_set}", frames_per_set=per_set)

    sizes = read_sizes(image_paths)
    plan = plan_frames(
        sizes,
        points,
        max_width=max_width,
        preset=preset,
        anchor_frac=anchor_frac,
        frames_per_set=per_set,
        shared_focus=shared_focus,
        crop_fraction=crop_fraction,
    )

    ensure_render_fits(len(image_paths), plan.out_size, max_pixels)

    set_count = len(image_paths) // per_set
    items = composite_sequence(
        set_count,
        per_set,
        mode,
        set_mode,
        cycles_per_set,
        fps,
        duration,
        custom_pattern,
        loops,
        composition,
        transition_frames,
        set_loops,
    )
    needed = estimate_render_bytes(sizes, plan, items, composition, set_count)
    try:
        reservation = (reserve_memory or unreserved)(needed)
    except MemoryError:
        raise too_large(len(image_paths), plan.out_size, needed_bytes=needed) from None
    with reservation:
        frames: list[np.ndarray] = []
        for i, path in enumerate(image_paths):
            im = read_image(path)
            if adjustments is not None:
                im = apply_adjust(im, adjustments[i])
            scale = parallax_scale(i % per_set, per_set, parallax_zoom)
            frames.append(to_i420(warp_frame(im, plan.alignment.offsets[i], plan, plan.alignment.targets[i], scale)))
        composed, seq = compose_all(frames, items, composition, per_set)
        del frames
        encode_mp4(composed, seq, fps, out_path, pix_fmt="yuv420p")
        poster = write_poster(from_i420(composed[seq[0]]), Path(out_path).with_suffix(".jpg"))
    w, h = plan.out_size
    return {"width": w, "height": h, "frames": len(seq), "fps": fps, "duration": len(seq) / fps, "poster": str(poster)}


@contextlib.contextmanager
def unreserved(_: int) -> Iterator[None]:
    yield


POSTER_JPEG_QUALITY = 90


def write_poster(frame: np.ndarray, path: Path) -> Path:
    cv2.imwrite(str(path), frame, [cv2.IMWRITE_JPEG_QUALITY, POSTER_JPEG_QUALITY])
    return path


SIGNATURE_SIDE = 64
HUE_BINS = 12


def color_signature(img: np.ndarray) -> list[float]:
    small = cv2.resize(img, (SIGNATURE_SIDE, SIGNATURE_SIDE), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float64)
    lab_mean = lab.mean(axis=0)
    lab_std = lab.std(axis=0)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.float64)
    weights = hsv[:, 1] * hsv[:, 2] / (255.0 * 255.0)
    hist, _ = np.histogram(hsv[:, 0], bins=HUE_BINS, range=(0, 180), weights=weights)
    total = float(hist.sum())
    hue = hist / total if total > 0 else np.zeros(HUE_BINS)
    return [round(float(v), 4) for v in (*lab_mean, *lab_std, *hue)]


STRUCTURE_COLS = 8
STRUCTURE_ROWS = 6


def structure_signature(img: np.ndarray) -> list[float]:
    small = cv2.resize(_gray(img), (STRUCTURE_COLS, STRUCTURE_ROWS), interpolation=cv2.INTER_AREA).astype(np.float64)
    centred = small - small.mean()
    spread = float(centred.std())
    normalised = centred / spread if spread > 1e-6 else np.zeros_like(centred)
    return [round(float(v), 4) for v in normalised.ravel()]


def tone_signature(img: np.ndarray) -> list[float]:
    gray = _gray(img).astype(np.float64)
    return [round(float(gray.mean()), 2), round(float(gray.std()), 2)]
