"""JSON profile file read/write (path from settings.profile_path)."""

import json
import os
import tempfile
from pathlib import Path

from core.config import settings

_profile_path = Path(settings.profile_path)


def get_empty_profile() -> dict:
    return {
        "personal": {
            "name": "",
            "email": "",
            "phone": None,
            "location": "",
            "urls": [],
        },
        "education": [],
        "work_experience": [],
        "projects": [],
        "other": [],
        "extra_skills": [],
        "_extracted": {
            "yoe": None,
            "skills": [],
            "extraction_mode": None,
            "extracted_at": None,
        },
    }


def read_profile() -> dict:
    """Read profile.json. Return empty profile structure if file doesn't exist."""
    if not _profile_path.exists():
        return get_empty_profile()
    try:
        raw = _profile_path.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            return get_empty_profile()
        return data
    except (json.JSONDecodeError, OSError):
        return get_empty_profile()


def write_profile(data: dict) -> None:
    """Write profile.json atomically (write to .tmp then rename)."""
    _profile_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=_profile_path.parent,
        prefix=".profile_",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, _profile_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
