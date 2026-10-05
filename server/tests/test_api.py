from __future__ import annotations

import io
import time
import zipfile

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import processing
from app.main import app, settings
from tests.test_processing import SHIFTS, _textured_frames, make_frames


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def encode_png(image: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", image)
    assert ok
    return buf.tobytes()


def upload(client: TestClient, images: list[np.ndarray], session_id: str | None = None) -> dict:
    files = [("files", (f"frame{i}.png", encode_png(im), "image/png")) for i, im in enumerate(images)]
    data = {"session_id": session_id} if session_id else {}
    r = client.post("/api/render/upload", files=files, data=data)
    assert r.status_code == 200, r.json()
    return r.json()


def test_healthz(client: TestClient):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_upload_rejects_unsupported_format_with_code(client: TestClient):
    r = client.post("/api/render/upload", files=[("files", ("notes.txt", b"hello", "text/plain"))])
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["code"] == "upload.unsupported_format"
    assert detail["params"]["filename"] == "notes.txt"


def test_upload_rejects_unreadable_image(client: TestClient):
    r = client.post("/api/render/upload", files=[("files", ("broken.jpg", b"not really a jpeg", "image/jpeg"))])
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "upload.unreadable"


def test_upload_rejects_oversized_file(client: TestClient):
    blob = b"\xff" * (settings.max_upload_bytes + 1)
    r = client.post("/api/render/upload", files=[("files", ("huge.jpg", blob, "image/jpeg"))])
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "upload.file_too_large"


def test_upload_downscales_large_frames(client: TestClient):
    frames, _ = _textured_frames(SHIFTS, W=1600, H=1200)
    result = upload(client, frames[:1])
    frame = result["frames"][0]
    assert max(frame["width"], frame["height"]) == settings.max_image_side
    assert frame["url"].startswith("/api/render/frames/")
    served = client.get(frame["url"])
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("image/")


def test_unknown_session_and_frame_codes(client: TestClient):
    assert client.get("/api/render/frames/nope/0").json()["detail"]["code"] == "session.invalid_id"
    assert client.get(f"/api/render/frames/{'0' * 32}/0").json()["detail"]["code"] == "session.not_found"
    result = upload(client, make_frames()[0][:1])
    r = client.get(f"/api/render/frames/{result['session_id']}/7")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "frame.not_found"


def test_full_flow_upload_match_order_render(client: TestClient):
    frames, original_points = _textured_frames(SHIFTS, W=1600, H=1200)
    result = upload(client, frames)
    sid = result["session_id"]
    assert result["total"] == 4
    scale = result["frames"][0]["width"] / 1600
    assert scale < 1
    points = [(x * scale, y * scale) for x, y in original_points]

    more = upload(client, frames[:1], session_id=sid)
    assert more["total"] == 5

    r = client.post(
        "/api/render/match", json={"session_id": sid, "ref_index": 0, "point": {"x": points[0][0], "y": points[0][1]}, "targets": [1, 2, 3]}
    )
    assert r.status_code == 200, r.json()
    matched = r.json()
    assert [m["index"] for m in matched["results"]] == [1, 2, 3]
    for m in matched["results"]:
        assert m["score"] > 0.6

    order = [2, 0, 3, 1]
    r = client.post("/api/render/order", json={"session_id": sid, "order": order})
    assert r.status_code == 200
    detected = r.json()["order"]
    assert detected in ([0, 1, 2, 3], [3, 2, 1, 0])

    all_points = [{"x": points[0][0], "y": points[0][1]}] + [{"x": m["x"], "y": m["y"]} for m in matched["results"]]
    r = client.post(
        "/api/render/render",
        json={
            "session_id": sid,
            "order": [0, 1, 2, 3],
            "points": all_points,
            "fps": 10,
            "duration": 1.2,
            "max_width": 480,
            "preset": "ig_square",
        },
    )
    assert r.status_code == 200, r.json()
    rendered = r.json()
    assert rendered["width"] == 1080 and rendered["height"] == 1080
    assert rendered["video_url"].startswith(f"/api/render/video/{sid}?name=out_0-1-2-3.mp4")

    video = client.get(rendered["video_url"])
    assert video.status_code == 200
    assert video.headers["content-type"] == "video/mp4"
    assert len(video.content) > 1000

    download = client.get(rendered["download_url"])
    assert "wigglegram_0-1-2-3.mp4" in download.headers["content-disposition"]


def test_render_two_sets_in_one_animation(client: TestClient):
    frames, points = make_frames()
    result = upload(client, frames + frames)
    sid = result["session_id"]
    body = {
        "session_id": sid,
        "order": [0, 1, 2, 3, 4, 5, 6, 7],
        "points": [{"x": x, "y": y} for x, y in points + points],
        "mode": "ends",
        "set_mode": "pingpong",
        "cycles_per_set": 2,
        "fps": 8,
        "duration": 1,
    }
    r = client.post("/api/render/render", json=body)
    assert r.status_code == 200, r.json()
    rendered = r.json()
    assert rendered["frames"] == 8
    assert rendered["video_name"] == "out_0-1-2-3-4-5-6-7.mp4"
    r = client.post("/api/render/render", json={**body, "loops": 3})
    assert r.status_code == 200, r.json()
    assert r.json()["frames"] == 24
    assert client.post("/api/render/render", json={**body, "loops": 5}).status_code == 422

    r = client.post("/api/render/render", json={**body, "shared_focus": False})
    assert r.status_code == 200, r.json()

    r = client.post("/api/render/render", json={**body, "order": [0, 1, 2, 3, 4, 5], "points": body["points"][:6]})
    assert r.status_code == 422
    r = client.post("/api/render/render", json={**body, "points": body["points"][:4]})
    assert r.status_code == 422

    r = client.post(
        "/api/render/match",
        json={"session_id": sid, "ref_index": 0, "point": {"x": points[0][0], "y": points[0][1]}, "targets": [1, 2, 3, 4, 5, 6, 7]},
    )
    assert r.status_code == 200, r.json()
    assert [m["index"] for m in r.json()["results"]] == [1, 2, 3, 4, 5, 6, 7]


def test_upload_writes_thumbnails_and_serves_them(client: TestClient):
    frames, _ = make_frames()
    result = upload(client, frames[:1])
    sid = result["session_id"]
    meta = result["frames"][0]
    assert meta["thumb_url"] == f"/api/render/frames/{sid}/0/thumb"
    r = client.get(meta["thumb_url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    thumb = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    assert thumb.shape[1] <= 240 and thumb.shape[1] < meta["width"]
    (settings.data_dir / sid / "thumb_0.jpg").unlink()
    assert client.get(meta["thumb_url"]).status_code == 200


def test_media_endpoints_answer_head_so_the_studio_can_probe_a_session(client: TestClient):
    frames, _ = make_frames()
    result = upload(client, frames[:1])
    meta = result["frames"][0]
    for url in (meta["url"], meta["thumb_url"]):
        head = client.head(url)
        assert head.status_code == 200, url
        assert head.content == b""
    assert client.head(f"/api/render/frames/{'0' * 32}/0").status_code == 404


def batch_job(order: list[int], points: list[tuple[float, float]]) -> dict:
    return {"order": order, "points": [{"x": x, "y": y} for x, y in points], "mode": "forward", "fps": 8, "duration": 0.5}


def wait_for_batch(client: TestClient, url: str) -> dict:
    for _ in range(200):
        state = client.get(url).json()
        if state["status"] != "running":
            return state
        time.sleep(0.05)
    raise AssertionError("batch did not finish")


def test_render_batch_makes_one_video_per_series_and_a_zip():
    frames, points = make_frames()
    with TestClient(app) as client:
        sid = upload(client, frames + frames + frames)["session_id"]
        body = {
            "session_id": sid,
            "items": [batch_job([0, 1, 2, 3], points), batch_job([8, 9, 10, 11], points)],
            "set_numbers": [1, 3],
        }
        started = client.post("/api/render/render/batch", json=body)
        assert started.status_code == 200, started.json()
        state = started.json()
        assert state["total"] == 2 and state["zip_url"] is None
        assert [item["set"] for item in state["items"]] == [1, 3]

        url = f"/api/render/render/batch/{sid}/{state['batch_id']}"
        state = wait_for_batch(client, url)
        assert state["status"] == "done" and state["done"] == 2
        assert [item["render"]["video_name"] for item in state["items"]] == ["out_0-1-2-3.mp4", "out_8-9-10-11.mp4"]
        assert state["zip_url"] == f"{url}/zip"
        assert client.delete(url).json()["status"] == "done"

        archive = client.get(state["zip_url"])
        assert archive.status_code == 200 and archive.headers["content-type"] == "application/zip"
        with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
            assert bundle.namelist() == ["wigglegram_series_01.mp4", "wigglegram_series_03.mp4"]

        assert client.get(f"/api/render/render/batch/{sid}/{'0' * 12}").json()["detail"]["code"] == "batch.not_found"
        assert client.get(f"/api/render/render/batch/{sid}/nope").status_code == 404


def test_render_batch_rejects_mismatched_set_numbers(client: TestClient):
    frames, points = make_frames()
    sid = upload(client, frames)["session_id"]
    body = {"session_id": sid, "items": [batch_job([0, 1, 2, 3], points)], "set_numbers": [1, 2]}
    assert client.post("/api/render/render/batch", json=body).status_code == 422
    body = {"session_id": sid, "items": [batch_job([0, 1, 2, 9], points)], "set_numbers": [1]}
    assert client.post("/api/render/render/batch", json=body).status_code == 400


def test_render_plays_each_set_with_its_own_loop_and_repeats(client: TestClient):
    frames, points = make_frames()
    sid = upload(client, frames + frames)["session_id"]
    body = {
        "session_id": sid,
        "order": [0, 1, 2, 3, 4, 5, 6, 7],
        "points": [{"x": x, "y": y} for x, y in points + points],
        "set_loops": [{"mode": "ends", "cycles": 2}, {"mode": "custom", "pattern": [1, 2], "cycles": 1}],
        "fps": 8,
        "loops": 1,
    }
    r = client.post("/api/render/render", json=body)
    assert r.status_code == 200, r.json()
    assert r.json()["frames"] == 6
    assert client.post("/api/render/render", json={**body, "set_loops": body["set_loops"][:1]}).status_code == 422
    too_many = {**body, "set_loops": [{"mode": "ends", "cycles": 5}, {"mode": "ends"}]}
    assert client.post("/api/render/render", json=too_many).status_code == 422


def test_render_accepts_sets_of_three_and_five_frames(client: TestClient):
    frames, points = make_frames()
    five = frames + frames[:1]
    five_points = points + points[:1]
    sid = upload(client, five + five)["session_id"]
    body = {
        "session_id": sid,
        "order": list(range(10)),
        "points": [{"x": x, "y": y} for x, y in five_points + five_points],
        "frames_per_set": 5,
        "set_loops": [{"mode": "forward"}, {"mode": "middle"}],
        "fps": 8,
        "loops": 1,
    }
    r = client.post("/api/render/render", json=body)
    assert r.status_code == 200, r.json()
    assert r.json()["frames"] == 7

    three = {**body, "order": [0, 1, 2], "points": body["points"][:3], "frames_per_set": 3, "set_loops": None}
    assert client.post("/api/render/render", json=three).status_code == 200
    assert client.post("/api/render/render", json={**three, "frames_per_set": 4}).status_code == 422
    assert client.post("/api/render/render", json={**three, "frames_per_set": 6}).status_code == 422

    r = client.post("/api/render/order", json={"session_id": sid, "order": [0, 1, 2]})
    assert r.status_code == 200 and sorted(r.json()["order"] or [0, 1, 2]) == [0, 1, 2]
    bad = {"session_id": sid, "order": [0, 1, 2], "points": body["points"][:2]}
    assert client.post("/api/render/order", json=bad).status_code == 422


def test_render_many_sets_in_one_animation(client: TestClient):
    frames, points = make_frames()
    sid = upload(client, frames * 5)["session_id"]
    body = {
        "session_id": sid,
        "order": list(range(20)),
        "points": [{"x": x, "y": y} for x, y in points * 5],
        "mode": "ends",
        "fps": 8,
        "duration": 1,
    }
    r = client.post("/api/render/render", json=body)
    assert r.status_code == 200, r.json()
    assert r.json()["frames"] == 10


def test_closing_a_session_removes_its_files(client: TestClient):
    frames, _ = make_frames()
    sid = upload(client, frames)["session_id"]
    assert client.delete(f"/api/render/session/{sid}").json() == {"closed": True}
    assert not (settings.data_dir / sid).exists()
    assert client.delete(f"/api/render/session/{sid}").status_code == 404


def test_palette_returns_a_signature_per_frame(client: TestClient):
    frames, _ = make_frames()
    sid = upload(client, frames)["session_id"]
    r = client.post("/api/render/palette", json={"session_id": sid, "indices": [3, 0]})
    assert r.status_code == 200, r.json()
    features = r.json()["features"]
    assert [f["index"] for f in features] == [3, 0]
    assert len(features[0]["signature"]) == 18
    assert len(features[0]["structure"]) == processing.STRUCTURE_COLS * processing.STRUCTURE_ROWS
    assert len(features[0]["tone"]) == 2
    assert client.post("/api/render/palette", json={"session_id": sid, "indices": [0, 9]}).status_code == 400


def test_render_errors_are_coded(client: TestClient):

    frames, points = make_frames()
    result = upload(client, frames)
    sid = result["session_id"]
    body = {"session_id": sid, "order": [0, 1, 2, 3], "points": [{"x": x, "y": y} for x, y in points]}

    r = client.post("/api/render/render", json={**body, "order": [0, 1, 2, 9]})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "frame.indices_out_of_range"

    r = client.post("/api/render/render", json={**body, "mode": "custom"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "render.pattern_required"

    r = client.post(
        "/api/render/render", json={**body, "points": [{"x": 0, "y": 0}, {"x": 399, "y": 299}, {"x": 0, "y": 299}, {"x": 399, "y": 0}]}
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "render.no_overlap"

    r = client.get(f"/api/render/video/{sid}?name=../etc/passwd")
    assert r.json()["detail"]["code"] == "video.invalid_name"
    r = client.get(f"/api/render/video/{sid}?name=out_3-2-1-0.mp4")
    assert r.json()["detail"]["code"] == "video.not_found"


def test_render_writes_a_poster(client: TestClient):
    frames, points = make_frames()
    sid = upload(client, frames)["session_id"]
    body = {"session_id": sid, "order": [3, 2, 1, 0], "points": [{"x": x, "y": y} for x, y in reversed(points)], "duration": 1, "fps": 6}
    rendered = client.post("/api/render/render", json=body).json()
    assert rendered["poster_url"] == f"/api/render/poster/{sid}?name=out_3-2-1-0.jpg"
    assert rendered["size_bytes"] > 0
    poster = client.get(rendered["poster_url"])
    assert poster.status_code == 200 and poster.headers["content-type"] == "image/jpeg"


def test_render_accepts_a_custom_crop(client: TestClient):
    frames, pts = make_frames()
    sid = upload(client, frames)["session_id"]
    body = {
        "session_id": sid,
        "order": [0, 1, 2, 3],
        "points": [{"x": x, "y": y} for x, y in pts],
        "preset": "custom",
        "crop": {"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5},
        "max_width": 200,
        "fps": 10,
        "duration": 1,
    }
    r = client.post("/api/render/render", json=body)
    assert r.status_code == 200, r.json()
    assert r.json()["width"] <= 200
    body.pop("crop")
    assert client.post("/api/render/render", json=body).json()["detail"]["code"] == "render.crop_required"


def strip_scan(frames: list[np.ndarray], gap: int = 20, margin: int = 30) -> np.ndarray:
    h, w = frames[0].shape[:2]
    canvas = np.full((h + 2 * margin, margin * 2 + w * len(frames) + gap * (len(frames) - 1), 3), 20, dtype=np.uint8)
    for k, frame in enumerate(frames):
        x = margin + k * (w + gap)
        canvas[margin : margin + h, x : x + w] = frame
    return canvas


def upload_scans(client: TestClient, scans: list[np.ndarray], session_id: str | None = None) -> dict:
    files = [("files", (f"scan{i}.png", encode_png(im), "image/png")) for i, im in enumerate(scans)]
    data = {"session_id": session_id} if session_id else {}
    r = client.post("/api/render/scans", files=files, data=data)
    assert r.status_code == 200, r.json()
    return r.json()


def test_scans_are_stored_with_previews_and_split_into_frames(client: TestClient):
    frames, _ = _textured_frames(SHIFTS, W=400, H=300)
    scan = strip_scan(frames)
    uploaded = upload_scans(client, [scan, scan])
    sid = uploaded["session_id"]
    assert uploaded["total"] == 2
    assert uploaded["scans"][0]["name"] == "scan0.png"
    preview = client.get(uploaded["scans"][1]["url"])
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/jpeg"
    assert client.get(uploaded["scans"][1]["thumb_url"]).status_code == 200

    sh, sw = scan.shape[:2]
    box = {"x": 30 / sw, "y": 30 / sh, "w": (sw - 60) / sw, "h": (sh - 60) / sh}
    r = client.post("/api/render/split", json={"session_id": sid, "count": 4, "axis": "x", "box": box, "gap": 20 / sw})
    assert r.status_code == 200, r.json()
    result = r.json()
    assert result["total"] == 8
    assert [f["index"] for f in result["frames"]] == list(range(8))
    assert result["frames"][5]["name"] == "scan1.png · 2"
    sizes = {(f["width"], f["height"]) for f in result["frames"]}
    assert len(sizes) == 1
    ((fw, fh),) = sizes
    assert abs(fw - 400) <= 1 and abs(fh - 300) <= 1
    served = client.get(result["frames"][2]["url"])
    assert served.status_code == 200
    cut = cv2.imdecode(np.frombuffer(served.content, np.uint8), cv2.IMREAD_COLOR)
    assert np.abs(cut.astype(int) - frames[2][: cut.shape[0], : cut.shape[1]].astype(int)).mean() < 6
    assert client.get(result["frames"][7]["thumb_url"]).status_code == 200


def test_split_replaces_earlier_frames_and_rejects_tiny_cells(client: TestClient):
    frames, _ = _textured_frames(SHIFTS, W=400, H=300)
    uploaded = upload_scans(client, [strip_scan(frames)])
    sid = uploaded["session_id"]
    full = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
    first = client.post("/api/render/split", json={"session_id": sid, "count": 2, "box": full, "gap": 0.0}).json()
    assert first["total"] == 2
    third = client.post("/api/render/split", json={"session_id": sid, "count": 3, "box": full, "gap": 0.0}).json()
    assert third["total"] == 3
    second = client.post("/api/render/split", json={"session_id": sid, "count": 4, "box": full, "gap": 0.0}).json()
    assert second["total"] == 4
    assert client.get(f"/api/render/frames/{sid}/3").status_code == 200
    assert first["frames"][0]["url"].split("?v=")[1] != second["frames"][0]["url"].split("?v=")[1]
    tiny = client.post("/api/render/split", json={"session_id": sid, "count": 4, "box": {"x": 0, "y": 0, "w": 0.1, "h": 0.1}, "gap": 0})
    assert tiny.status_code == 400
    assert tiny.json()["detail"]["code"] == "render.split_too_small"


def test_split_without_scans_is_coded(client: TestClient):
    plain = upload(client, make_frames()[0][:1])
    full = {"x": 0, "y": 0, "w": 1, "h": 1}
    r = client.post("/api/render/split", json={"session_id": plain["session_id"], "count": 2, "box": full, "gap": 0})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "split.no_scans"


def test_split_can_cut_each_scan_with_its_own_frame(client: TestClient):
    frames, _ = _textured_frames(SHIFTS, W=400, H=300)
    scan = strip_scan(frames)
    uploaded = upload_scans(client, [scan, scan])
    sh, sw = scan.shape[:2]
    shared = {"x": 30 / sw, "y": 30 / sh, "w": (sw - 60) / sw, "h": (sh - 60) / sh}
    second = {"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0}
    body = {
        "session_id": uploaded["session_id"],
        "count": 4,
        "box": shared,
        "gap": 20 / sw,
        "scans": [{"axis": "x", "box": shared, "gap": 20 / sw}, {"axis": "y", "box": second, "gap": 0.0}],
    }
    r = client.post("/api/render/split", json=body)
    assert r.status_code == 200, r.json()
    result = r.json()["frames"]
    assert abs(result[0]["width"] - 400) <= 1 and abs(result[0]["height"] - 300) <= 1
    assert abs(result[4]["width"] - sw // 2) <= 1 and abs(result[4]["height"] - sh // 4) <= 1


def test_unknown_paths_fall_back_to_the_studio_page(client: TestClient):
    page = client.get("/some/deep/link")
    assert page.status_code == 200
    assert "Lenti Studio" in page.text
    assert client.get("/api/render/frames/" + "0" * 32 + "/0").status_code == 404
