from __future__ import annotations

import json
import logging
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from dateutil.relativedelta import relativedelta

from matching.normaliser import normalise

logger = logging.getLogger(__name__)

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
_SKILL_ALIASES_PATH = _BACKEND_ROOT / "matching" / "skill_aliases.json"

_aliases_cache: dict[str, list[str]] | None = None


def load_skill_aliases() -> dict[str, list[str]]:
    """
    Load skill_aliases.json from backend/matching/skill_aliases.json.
    Returns dict: { "CanonicalName": ["alias1", ...] }
    Cache in module-level variable after first load.
    """
    global _aliases_cache
    if _aliases_cache is not None:
        return _aliases_cache
    data = json.loads(_SKILL_ALIASES_PATH.read_text(encoding="utf-8"))
    out: dict[str, list[str]] = {}
    for k, v in data.items():
        if k.startswith("_"):
            continue
        if isinstance(v, list):
            out[k] = v
    _aliases_cache = out
    return out


def invalidate_skill_aliases_cache() -> None:
    global _aliases_cache
    _aliases_cache = None


def _parse_month(s: str) -> tuple[int, int]:
    s = (s or "").strip()[:7]
    parts = s.split("-")
    if len(parts) < 2:
        raise ValueError("invalid month")
    y, m = int(parts[0]), int(parts[1])
    return y, m


def _month_tuple_to_date(y: int, m: int) -> datetime:
    return datetime(y, m, 1, tzinfo=timezone.utc)


def compute_yoe(work_experience: list) -> float:
    """
    Compute total years of experience from work_experience entries.
    For each entry: months = (end - start) in months + 1  (inclusive)
    If end_date is null: use current month.
    Returns rounded float (1 decimal place).
    """
    if not work_experience:
        return 0.0
    now = datetime.now(timezone.utc)
    total_months = 0
    for entry in work_experience:
        if not isinstance(entry, dict):
            continue
        start_raw = entry.get("start_date") or ""
        end_raw = entry.get("end_date")
        try:
            sy, sm = _parse_month(str(start_raw))
            start_dt = _month_tuple_to_date(sy, sm)
        except (ValueError, TypeError):
            continue
        if end_raw:
            try:
                ey, em = _parse_month(str(end_raw))
                end_dt = _month_tuple_to_date(ey, em)
            except (ValueError, TypeError):
                continue
        else:
            end_dt = _month_tuple_to_date(now.year, now.month)
        delta = relativedelta(end_dt, start_dt)
        months = delta.years * 12 + delta.months + 1
        total_months += max(0, months)
    years = total_months / 12.0
    return round(years, 1)


def _normalise_extra_skills_input(raw: object) -> list[str]:
    """CSV-split, normalise via skill aliases, dedupe preserving order (list or str)."""
    if raw is None:
        return []
    if isinstance(raw, str):
        items: list = [raw]
    elif isinstance(raw, list):
        items = list(raw)
    else:
        return []
    tokens: list[str] = []
    for item in items:
        s = str(item).strip()
        if not s:
            continue
        if "," in s:
            for part in s.split(","):
                t = part.strip()
                if t:
                    tokens.append(t)
        else:
            tokens.append(s)
    out: list[str] = []
    seen: set[str] = set()
    for t in tokens:
        c = normalise(t)
        if not c:
            continue
        k = c.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


def cpu_extract_skills(texts: list[str], aliases: dict[str, list[str]]) -> list[str]:
    """
    Scan texts for known skill names and aliases from skill_aliases.json.
    Case-insensitive substring match.
    Returns list of canonical skill names found.
    Never invents skills not in the alias file.
    """
    hay = " ".join(str(t or "") for t in texts).lower()
    found: set[str] = set()
    for canonical, als in aliases.items():
        candidates = [canonical] + list(als)
        for c in candidates:
            if c.lower() in hay:
                found.add(canonical)
                break
    return sorted(found)


def _parse_llm_skill_json(text: str) -> list[str] | None:
    t = text.strip()
    m = re.search(r"\[.*\]", t, re.DOTALL)
    if m:
        t = m.group(0)
    try:
        data = json.loads(t)
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
    except json.JSONDecodeError:
        pass
    return None


async def _llm_extract_skills(description: str) -> list[str] | None:
    import time

    from core.trace import emit_llm_trace_event

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.warning("OPENAI_API_KEY not set; skipping LLM skill extraction")
        return None
    try:
        from openai import AsyncOpenAI
    except ImportError:
        logger.warning("openai package not installed; skipping LLM skill extraction")
        return None

    prompt = (
        "Extract all technical skills mentioned in the following text.\n"
        "Return a JSON object with a single key \"skills\" whose value is an array of "
        "canonical skill names. No other keys. No explanation, no markdown.\n"
        "Use canonical forms: PostgreSQL not Postgres, React not ReactJS,\n"
        "Kubernetes not K8s, Node.js not NodeJS, Go not Golang.\n"
        "Include: languages, frameworks, databases, tools, cloud platforms,\n"
        "methodologies. Exclude soft skills and job titles.\n\n"
        f"Text: {description}"
    )
    t0 = time.monotonic()
    outcome = "ok"
    parse_ok = True
    retries = 0
    token_in: int | None = None
    token_out: int | None = None
    error_class: str | None = None
    error_msg: str | None = None
    _model = "gpt-4o-mini"
    try:
        async with AsyncOpenAI(api_key=api_key) as client:
            message = await client.chat.completions.create(
                model=_model,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
            )
        if hasattr(message, "usage") and message.usage:
            token_in = getattr(message.usage, "prompt_tokens", None)
            token_out = getattr(message.usage, "completion_tokens", None)
        raw = (message.choices[0].message.content or "").strip()
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                arr = data.get("skills")
                if isinstance(arr, list):
                    out = [str(x).strip() for x in arr if str(x).strip()]
                    if out:
                        return out
        except json.JSONDecodeError:
            parse_ok = False
        skills = _parse_llm_skill_json(raw)
        if skills is not None:
            return skills
        logger.warning("LLM skill response was not usable JSON; falling back to CPU")
        outcome = "cpu_fallback"
        parse_ok = False
    except Exception as exc:
        outcome = "fail"
        parse_ok = False
        error_class = type(exc).__name__
        error_msg = str(exc)[:500]
        logger.warning("LLM skill extraction failed: %s", exc)
    finally:
        emit_llm_trace_event(
            phase="llm_extract_profile_skills",
            model=_model,
            t0_monotonic=t0,
            job_id=None,
            outcome=outcome,
            parse_ok=parse_ok,
            retries=retries,
            token_in=token_in,
            token_out=token_out,
            error_class=error_class,
            error_msg=error_msg,
        )
    return None


async def extract_profile(profile_data: dict, llm: bool) -> dict:
    """
    Run extraction on profile data. Returns updated profile dict.
    """
    out = deepcopy(profile_data)
    aliases = load_skill_aliases()
    work_experience = out.get("work_experience") or []
    projects = out.get("projects") or []

    yoe = compute_yoe(work_experience if isinstance(work_experience, list) else [])
    all_skill_sets: list[list[str]] = []
    any_llm_fallback = False

    if isinstance(work_experience, list):
        for entry in work_experience:
            if not isinstance(entry, dict):
                continue
            desc = str(entry.get("description") or "")
            texts = [desc]
            cpu_skills = cpu_extract_skills(texts, aliases)
            skills: list[str] = cpu_skills
            if llm and desc.strip():
                llm_skills = await _llm_extract_skills(desc)
                if llm_skills is not None:
                    skills = llm_skills
                else:
                    any_llm_fallback = True
                    skills = cpu_skills
            entry["skills"] = skills
            all_skill_sets.append(skills)

    if isinstance(projects, list):
        for entry in projects:
            if not isinstance(entry, dict):
                continue
            desc = str(entry.get("description") or "")
            texts = [desc]
            cpu_skills = cpu_extract_skills(texts, aliases)
            skills = cpu_skills
            if llm and desc.strip():
                llm_skills = await _llm_extract_skills(desc)
                if llm_skills is not None:
                    skills = llm_skills
                else:
                    any_llm_fallback = True
                    skills = cpu_skills
            entry["skills"] = skills
            all_skill_sets.append(skills)

    union: set[str] = set()
    for s in all_skill_sets:
        union.update(s)
    union_list = sorted(union)

    extra_raw = out.get("extra_skills")
    extra_clean = _normalise_extra_skills_input(extra_raw)
    out["extra_skills"] = extra_clean

    merged_skills = list(union_list)
    seen_lower = {s.lower() for s in merged_skills}
    for sk in extra_clean:
        lk = sk.lower()
        if lk not in seen_lower:
            merged_skills.append(sk)
            seen_lower.add(lk)

    extracted = out.get("_extracted")
    if not isinstance(extracted, dict):
        extracted = {}
    extracted["yoe"] = yoe
    extracted["skills"] = merged_skills
    extracted["extracted_at"] = datetime.now(timezone.utc).isoformat()
    if not llm:
        extracted["extraction_mode"] = "cpu"
    elif any_llm_fallback:
        extracted["extraction_mode"] = "llm_partial"
    else:
        extracted["extraction_mode"] = "llm"
    out["_extracted"] = extracted
    return out
