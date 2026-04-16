import json
from functools import lru_cache
from pathlib import Path

ALIASES_PATH = Path(__file__).parent / "skill_aliases.json"


@lru_cache(maxsize=1)
def _load_aliases() -> dict[str, str]:
    """
    Load skill_aliases.json and build a flat lookup:
        alias_lowercase → canonical_name

    File structure:
        {"CanonicalName": ["alias1", "alias2", ...], ...}

    Returns dict where every alias (and the canonical name itself)
    maps to the canonical name.
    """
    with open(ALIASES_PATH, encoding="utf-8") as f:
        raw = json.load(f)

    lookup: dict[str, str] = {}
    for canonical, aliases in raw.items():
        if not isinstance(canonical, str) or canonical.startswith("_"):
            continue
        lookup[canonical.lower()] = canonical
        if not isinstance(aliases, list):
            continue
        for alias in aliases:
            if isinstance(alias, str) and alias.strip():
                lookup[alias.lower()] = canonical
    return lookup


def skill_in_alias_lookup(skill: str | None) -> bool:
    """True if ``skill`` matches a canonical name or any alias in skill_aliases.json."""
    if not skill or not str(skill).strip():
        return False
    return str(skill).strip().lower() in _load_aliases()


def normalise(skill: str | None) -> str | None:
    """
    Normalise a single skill name to its canonical form.
    Returns None if input is None or empty.
    Returns the canonical name if found in aliases,
    otherwise returns the original skill stripped.
    """
    if not skill or not skill.strip():
        return None
    lookup = _load_aliases()
    key = skill.strip().lower()
    return lookup.get(key, skill.strip())


def normalise_list(skills: list[str] | None) -> list[str]:
    """
    Normalise a list of skill names. Deduplicates after normalisation.
    Returns empty list for None or empty input.
    """
    if not skills:
        return []
    seen: set[str] = set()
    result: list[str] = []
    for skill in skills:
        norm = normalise(skill)
        if norm and norm not in seen:
            seen.add(norm)
            result.append(norm)
    return result
