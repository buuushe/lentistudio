import os
import tempfile
from pathlib import Path

_data_dir = tempfile.mkdtemp(prefix="studio-sessions-")
_spa_dir = Path(tempfile.mkdtemp(prefix="studio-spa-"))
(_spa_dir / "index.html").write_text(
    '<!doctype html>\n<html lang="en"><head><title>Lenti Studio</title></head><body><div id="app"></div></body></html>\n'
)
os.environ.setdefault("SPA_DIR", str(_spa_dir))
os.environ.setdefault("DATA_DIR", _data_dir)
os.environ.setdefault("MAX_IMAGE_SIDE", "1200")
os.environ.setdefault("MAX_UPLOAD_MB", "5")
