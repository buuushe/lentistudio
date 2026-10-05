from __future__ import annotations

from typing import Any

from fastapi import HTTPException


class ApiError(HTTPException):
    def __init__(self, status_code: int, code: str, message: str, headers: dict[str, str] | None = None, **params: Any) -> None:
        super().__init__(status_code, {"code": code, "message": message, "params": params}, headers=headers)
        self.code = code


def invalid_session_id() -> ApiError:
    return ApiError(400, "session.invalid_id", "Invalid session id")


def session_not_found() -> ApiError:
    return ApiError(404, "session.not_found", "Session not found or expired")


def frame_not_found(index: int) -> ApiError:
    return ApiError(404, "frame.not_found", f"Frame {index} not found", index=index)


def frames_not_found(indices: list[int], total: int) -> ApiError:
    return ApiError(
        400, "frame.indices_out_of_range", f"Frames {indices} are not in the session ({total} total)", indices=indices, total=total
    )


def no_files() -> ApiError:
    return ApiError(400, "upload.no_files", "No files were selected")


def library_full(limit: int) -> ApiError:
    return ApiError(400, "upload.library_full", f"The library can hold at most {limit} frames", limit=limit)


def unsupported_format(filename: str) -> ApiError:
    return ApiError(400, "upload.unsupported_format", f"Unsupported file format: {filename}", filename=filename)


def file_too_large(filename: str, limit_mb: int) -> ApiError:
    return ApiError(413, "upload.file_too_large", f"{filename} is larger than {limit_mb} MB", filename=filename, limitMb=limit_mb)


def image_too_big(filename: str, max_pixels: int) -> ApiError:
    return ApiError(400, "upload.image_too_big", f"{filename} has too many pixels", filename=filename, maxPixels=max_pixels)


def unreadable_image(filename: str) -> ApiError:
    return ApiError(400, "upload.unreadable", f"Could not read image: {filename}", filename=filename)


def scan_not_found(index: int) -> ApiError:
    return ApiError(404, "scan.not_found", f"Scan {index} not found", index=index)


def no_scans() -> ApiError:
    return ApiError(400, "split.no_scans", "Upload scans before splitting them")


def disk_full() -> ApiError:
    return ApiError(507, "upload.disk_full", "The server is out of space, try again later")


def invalid_video_name() -> ApiError:
    return ApiError(400, "video.invalid_name", "Invalid video name")


def video_not_found() -> ApiError:
    return ApiError(404, "video.not_found", "The video has not been rendered yet")


def processing_failed(code: str, message: str, **params: Any) -> ApiError:
    return ApiError(400, f"render.{code}", message, **params)


def encoding_failed(message: str) -> ApiError:
    return ApiError(500, "render.encode_failed", message)


def batch_not_found() -> ApiError:
    return ApiError(404, "batch.not_found", "Batch not found or expired")


def batch_not_ready() -> ApiError:
    return ApiError(409, "batch.not_ready", "The batch has no finished videos yet")
