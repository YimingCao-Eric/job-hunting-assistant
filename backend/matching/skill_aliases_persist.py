"""Read/write skill_aliases.json on disk; invalidate normaliser + profile caches."""

from __future__ import annotations

import json

from matching.normaliser import ALIASES_PATH, _load_aliases

_SKILLS_META_PREFIX = "_"


def invalidate_skill_alias_caches() -> None:
    _load_aliases.cache_clear()
    import profile.service as profile_service

    profile_service.invalidate_skill_aliases_cache()


def load_raw_aliases_file() -> dict:
    with open(ALIASES_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_raw_aliases_file(data: dict) -> None:
    with open(ALIASES_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    invalidate_skill_alias_caches()


def iter_canonical_entries(raw: dict) -> dict[str, list]:
    """Canonical name → alias list (excludes _comment etc.)."""
    return {k: v for k, v in raw.items() if not k.startswith(_SKILLS_META_PREFIX) and isinstance(v, list)}


def find_canonical_key(raw: dict, name: str) -> str | None:
    target = (name or "").strip().lower()
    if not target:
        return None
    for k, v in raw.items():
        if k.startswith(_SKILLS_META_PREFIX) or not isinstance(v, list):
            continue
        if k.lower() == target:
            return k
    return None


def write_new_canonical(canonical: str) -> None:
    c = canonical.strip()
    if not c:
        raise ValueError("canonical name required")
    raw = load_raw_aliases_file()
    entries = iter_canonical_entries(raw)
    if find_canonical_key(raw, c):
        return
    raw[c] = []
    save_raw_aliases_file(raw)


def add_alias_to_canonical(canonical_key: str, alias: str) -> None:
    alias_st = alias.strip()
    if not alias_st:
        raise ValueError("alias required")
    raw = load_raw_aliases_file()
    key = find_canonical_key(raw, canonical_key)
    if not key:
        raise ValueError(f"unknown canonical: {canonical_key!r}")
    lst = raw[key]
    if not isinstance(lst, list):
        lst = []
        raw[key] = lst
    if alias_st not in lst and key != alias_st:
        lst.append(alias_st)
    save_raw_aliases_file(raw)
