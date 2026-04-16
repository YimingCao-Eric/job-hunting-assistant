"""Step B: CPU and LLM JD extraction."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from matching.constants import (
    EDUCATION_PATTERNS,
    MATCHING_MODEL,
    NTH_SECTION_MARKERS,
    SPONSORSHIP_DENY_PHRASES,
    SPONSORSHIP_OFFER_PHRASES,
    YOE_PATTERNS,
)
from profile.service import cpu_extract_skills, load_skill_aliases

logger = logging.getLogger(__name__)

_SALARY_NOISE = (
    "competitive",
    "market rate",
    "commensurate",
    "depending on experience",
    "doe",
    "to be discussed",
)

_ANNUAL_NEAR_SALARY = (
    "per year",
    "annually",
    "/year",
    "a year",
    "yearly",
    "annual salary",
    "per annum",
    "p.a.",
    "pa ",
)

_MONTHLY_NEAR_SALARY = (
    "per month",
    "monthly",
    "/month",
    "a month",
    "/mo",
    " pm ",
)


def _parse_money_token(raw: str, *, is_k_suffix: bool) -> float:
    s = raw.replace(",", "").strip()
    if not s:
        return 0.0
    v = float(s)
    if is_k_suffix:
        v *= 1000.0
    return float(int(v))


def _salary_context_window(full_text: str, start: int, end: int, radius: int = 100) -> str:
    lo = max(0, start - radius)
    hi = min(len(full_text), end + radius)
    return full_text[lo:hi].lower()


def _annualise_salary_candidate(
    annual_cad: float,
    *,
    context: str,
    is_usd: bool,
    usd_mult: float,
) -> float | None:
    """Apply USD multiplier and monthly ×12 only when appropriate (context is local)."""
    annual_ind = any(a in context for a in _ANNUAL_NEAR_SALARY)
    monthly_ind = any(m in context for m in _MONTHLY_NEAR_SALARY)
    v = annual_cad * (usd_mult if is_usd else 1.0)
    if monthly_ind and not annual_ind:
        v *= 12.0
    if v > 500_000:
        return None
    if v < 10_000:
        return None
    return round(v, 2)


def _extract_salary_min_cpu(full_text: str, text_lower: str) -> float | None:
    """
    First salary-like pattern in the document only (avoids commission tables later).
    Range: lower bound is ``salary_min``. Never ×12 when annual indicators touch the match.
    """
    has_figure = bool(re.search(r"\$[\d,]+|\b\d{2,3}\s*k\b", full_text, re.I))
    if any(x in text_lower for x in _SALARY_NOISE) and not has_figure:
        return None

    is_usd = any(t in text_lower for t in ("usd", "us$", "u.s."))
    usd_mult = 1.35 if is_usd else 1.0

    # (start, tie_breaker, match, kind) — kind 0 = range $…$…, 1 = range k…k, 2 = single $…
    candidates: list[tuple[int, int, re.Match[str], str]] = []

    range_dollar = re.compile(
        r"\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*[-–—]\s*\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?)",
        re.I,
    )
    range_k = re.compile(
        r"\$(\d+(?:\.\d+)?)\s*k\s*[-–—]\s*\$(\d+(?:\.\d+)?)\s*k\b",
        re.I,
    )
    single_dollar = re.compile(
        r"\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\b",
        re.I,
    )
    single_k = re.compile(r"\$(\d+(?:\.\d+)?)\s*k\b", re.I)

    for m in range_dollar.finditer(full_text):
        candidates.append((m.start(), 0, m, "range_dollar"))
    for m in range_k.finditer(full_text):
        candidates.append((m.start(), 1, m, "range_k"))
    for m in single_dollar.finditer(full_text):
        candidates.append((m.start(), 2, m, "single_dollar"))
    for m in single_k.finditer(full_text):
        candidates.append((m.start(), 3, m, "single_k"))

    if not candidates:
        return None

    candidates.sort(key=lambda x: (x[0], x[1]))
    _, _, m, kind = candidates[0]
    ctx = _salary_context_window(full_text, m.start(), m.end())

    if kind == "range_dollar":
        a, b = m.group(1), m.group(2)
        v0 = _parse_money_token(a, is_k_suffix=False)
        v1 = _parse_money_token(b, is_k_suffix=False)
        lower = min(v0, v1)
        return _annualise_salary_candidate(lower, context=ctx, is_usd=is_usd, usd_mult=usd_mult)

    if kind == "range_k":
        a, b = m.group(1), m.group(2)
        v0 = _parse_money_token(a, is_k_suffix=True)
        v1 = _parse_money_token(b, is_k_suffix=True)
        lower = min(v0, v1)
        return _annualise_salary_candidate(lower, context=ctx, is_usd=is_usd, usd_mult=usd_mult)

    if kind == "single_dollar":
        raw = m.group(1)
        v = _parse_money_token(raw, is_k_suffix=False)
        return _annualise_salary_candidate(v, context=ctx, is_usd=is_usd, usd_mult=usd_mult)

    # single_k
    raw = m.group(1)
    v = _parse_money_token(raw, is_k_suffix=True)
    return _annualise_salary_candidate(v, context=ctx, is_usd=is_usd, usd_mult=usd_mult)


def normalize_skill_token(skill: str, aliases: dict[str, list[str]]) -> str:
    s = skill.strip()
    if not s:
        return s
    low = s.lower()
    for canonical, als in aliases.items():
        if canonical.lower() == low or low == canonical:
            return canonical
        for a in als:
            if a.lower() == low:
                return canonical
    return s


def normalize_skills_list(skills: list[str], aliases: dict[str, list[str]]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for sk in skills:
        c = normalize_skill_token(sk, aliases)
        if c and c.lower() not in seen:
            seen.add(c.lower())
            out.append(c)
    return out


def _jd_blob(job_title: str, job_description: str | None) -> str:
    parts = [job_title or "", job_description or ""]
    return "\n".join(p for p in parts if p)


def _find_nth_split(text_lower: str) -> int:
    nth_start = len(text_lower)
    for marker in NTH_SECTION_MARKERS:
        idx = text_lower.find(marker)
        if 0 <= idx < nth_start:
            nth_start = idx
    return nth_start


def cpu_extract_jd(job_title: str, job_description: str | None, aliases: dict[str, list[str]]) -> dict[str, Any]:
    """
    Extract structured fields from JD. Null / unknown when not found — never invents.

    ``extracted_yoe`` is the minimum years of experience **required by the JD** (Step B),
    not profile YOE.
    """
    logger.debug("[extractor/cpu] Starting CPU extraction | title=%r", job_title)
    full = _jd_blob(job_title, job_description)
    text_lower = full.lower()

    yoe_val = None
    for pattern in YOE_PATTERNS:
        m = re.search(pattern, text_lower)
        if m:
            if len(m.groups()) >= 2 and m.lastindex and m.lastindex >= 2:
                yoe_val = float(m.group(1))
            else:
                yoe_val = float(m.group(1))
            break

    salary_min = _extract_salary_min_cpu(full, text_lower)

    edu_degree = None
    for level, patterns in EDUCATION_PATTERNS.items():
        if any(re.search(p, text_lower) for p in patterns):
            edu_degree = level
            break

    visa = "unknown"
    if any(phrase in text_lower for phrase in SPONSORSHIP_DENY_PHRASES):
        visa = "false"
    elif any(phrase in text_lower for phrase in SPONSORSHIP_OFFER_PHRASES):
        visa = "true"

    nth_start = _find_nth_split(text_lower)
    required_text = text_lower[:nth_start]
    nth_text = text_lower[nth_start:] if nth_start < len(text_lower) else ""

    req_skills = cpu_extract_skills([required_text], aliases)
    nth_raw = cpu_extract_skills([nth_text], aliases) if nth_text.strip() else []
    nice_skills = [s for s in nth_raw if s not in set(req_skills)]

    jd_incomplete = (
        len(req_skills) == 0 and len(nice_skills) == 0 and yoe_val is None
    )

    logger.debug(
        "[extractor/cpu] Done | skills_req=%s | yoe=%s",
        len(req_skills),
        yoe_val,
    )
    return {
        "extracted_yoe": yoe_val,
        "extracted_salary_min": salary_min,
        "education_req_degree": edu_degree,
        "education_req_field": None,
        "education_field_qualified": None,
        "visa_req": visa,
        "required_skills": req_skills,
        "nice_to_have_skills": nice_skills,
        "other_notes": None,
        "jd_incomplete": jd_incomplete,
    }


def _profile_highest_education_field(profile: dict) -> str | None:
    edu = profile.get("education") or []
    if not edu:
        return None
    entry = edu[0]
    if isinstance(entry, dict):
        return (entry.get("field") or "").strip() or None
    return None


def _education_field_instruction(profile: dict) -> str:
    field = _profile_highest_education_field(profile)
    if not field:
        return (
            '  "education_field_qualified": always null (no profile education field to compare).\n'
        )
    return (
        f'  "education_field_qualified": boolean or null — if "education_required_field" is non-null, '
        f'true if a degree in "{field}" qualifies for that field of study in a software engineering role, '
        f"false otherwise; null when education_required_field is null.\n"
    )


def _build_llm_prompt(
    job_description: str,
    profile: dict,
    aliases: dict[str, list[str]],
) -> str:
    edu_instr = _education_field_instruction(profile)
    return f"""You are extracting structured data from a job description.
Return a single JSON object with exactly these fields.
Return null for any field not determinable from the JD text.
Do not invent or infer information not explicitly stated.

Fields:
  yoe_required:
    Extract only if an explicit numeric value is stated.
    e.g. "5+ years", "3-5 years" (take lower bound), "minimum 4 years".
    null if no explicit number found.

  salary_min:
    float (annualised CAD) or null.
    Convert USD × 1.35 if currency is USD.
    null if salary not mentioned or only described as "competitive" / "market rate" without figures.
    Do not include salary_max.

  education_required_degree:
    "phd" | "master" | "bachelor" | "none" | null
    null = not mentioned at all.
    "none" = explicitly states no degree required.

  education_required_field:
    string or null — only if JD specifies a required field of study.

{edu_instr}
  visa_sponsorship_required:
    "false" if JD explicitly states sponsorship is NOT available.
    "true"  if JD explicitly states sponsorship IS available.
    "unknown" if not mentioned (default).

  required_skills: array of canonical technical skill names.
    If the JD does NOT explicitly distinguish required from nice-to-have sections,
    place ALL extracted technical skills here.
    Canonical: PostgreSQL not Postgres, React not ReactJS, Kubernetes not K8s, Node.js not NodeJS, Go not Golang.
    No soft skills.

  nice_to_have_skills: array.
    Only if JD explicitly marks preferred/bonus/nice-to-have. Otherwise [].
    If a skill is both, keep only in required_skills.

  other_notes:
    string or null.
    1–2 sentences maximum.
    Capture only application-relevant information NOT already covered by
    the structured fields above. Focus on what would help a motivated
    candidate decide whether to click Apply.
    Examples: unusual application process, compensation structure beyond
    base salary, team context, work schedule constraints, company stage.
    DO NOT repeat skills, salary, education, or visa information.
    null if nothing notable beyond the structured fields.

  jd_incomplete: boolean — true if after extraction you found no skills and no yoe_required.

JSON keys MUST be exactly:
"yoe_required","salary_min","education_required_degree","education_required_field",
"education_field_qualified","visa_sponsorship_required","required_skills","nice_to_have_skills","other_notes","jd_incomplete"

Job description:
{job_description}
"""


def _parse_llm_jd_json(text: str) -> dict[str, Any] | None:
    t = text.strip()
    if "```" in t:
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    try:
        start = t.find("{")
        end = t.rfind("}")
        if start >= 0 and end > start:
            t = t[start : end + 1]
        return json.loads(t)
    except json.JSONDecodeError:
        return None


async def llm_extract_jd(
    job_title: str,
    job_description: str | None,
    aliases: dict[str, list[str]],
    profile: dict,
    job_id: str | None = None,
) -> dict[str, Any]:
    jid = job_id if job_id is not None else "(no id)"
    logger.info(
        "[extractor/llm] Starting LLM extraction | job_id=%s | title=%r",
        jid,
        job_title,
    )
    logger.debug(
        "[extractor/llm] JD length: %s chars | job_id=%s",
        len(job_description or ""),
        jid,
    )

    def _cpu_fallback() -> dict[str, Any]:
        out = cpu_extract_jd(job_title, job_description, aliases)
        out["_step_b_matching_mode"] = "cpu"
        return out

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.warning(
            "[extractor/llm] OPENAI_API_KEY not set — falling back to CPU | job_id=%s",
            jid,
        )
        return _cpu_fallback()

    blob = _jd_blob(job_title, job_description)
    if not blob.strip():
        logger.debug(
            "[extractor/llm] Empty JD blob — using CPU | job_id=%s",
            jid,
        )
        return _cpu_fallback()

    logger.info(
        "[extractor/llm] API key present (len=%s) | model=%s | job_id=%s",
        len(api_key),
        MATCHING_MODEL,
        jid,
    )

    logger.debug("[extractor/llm] Building prompt | job_id=%s", jid)
    prompt = _build_llm_prompt(blob, profile, aliases)
    logger.info(
        "[extractor/llm] Prompt built | total_chars=%s | job_id=%s",
        len(prompt),
        jid,
    )

    try:
        from openai import AsyncOpenAI
    except ImportError as e:
        logger.error(
            "[extractor/llm] OpenAI SDK import failed | job_id=%s | error=%s",
            jid,
            e,
            exc_info=True,
        )
        logger.warning(
            "[extractor/llm] Falling back to CPU | job_id=%s",
            jid,
        )
        return _cpu_fallback()

    data: dict[str, Any] | None = None
    for attempt in (1, 2):
        logger.info(
            "[extractor/llm] Calling %s | job_id=%s | attempt=%s",
            MATCHING_MODEL,
            jid,
            attempt,
        )
        try:
            async with AsyncOpenAI(api_key=api_key) as client:
                msg = await client.chat.completions.create(
                    model=MATCHING_MODEL,
                    max_tokens=4096,
                    messages=[{"role": "user", "content": prompt}],
                    response_format={"type": "json_object"},
                    timeout=60.0,
                )
            logger.info("[extractor/llm] API call returned | job_id=%s", jid)
            choice = msg.choices[0].message
            response_text = (choice.content or "").strip()
            raw_preview = response_text[:300] if response_text else "EMPTY"
            logger.debug(
                "[extractor/llm] Raw response (first 300 chars): %s | job_id=%s",
                raw_preview,
                jid,
            )
            parsed = _parse_llm_jd_json(response_text)
            if parsed is None:
                if attempt == 1:
                    logger.warning(
                        "[extractor/llm] First parse failed, retrying | job_id=%s",
                        jid,
                    )
                continue
            logger.info("[extractor/llm] JSON parsed OK | job_id=%s", jid)
            data = parsed
            break
        except Exception as e:
            logger.error(
                "[extractor/llm] API call or parse FAILED | job_id=%s | "
                "error_type=%s | error=%s",
                jid,
                type(e).__name__,
                e,
                exc_info=True,
            )
            if attempt == 1:
                logger.warning(
                    "[extractor/llm] Retrying after error | job_id=%s",
                    jid,
                )
                continue
            logger.warning(
                "[extractor/llm] Falling back to CPU | job_id=%s",
                jid,
            )
            return _cpu_fallback()

    if data is None:
        logger.warning(
            "[extractor/llm] LLM extraction failed, using CPU fallback | job_id=%s",
            jid,
        )
        return _cpu_fallback()

    def _null_num(v: Any) -> float | None:
        if v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    yoe = _null_num(data.get("yoe_required"))
    sal = _null_num(data.get("salary_min"))

    edu_deg = data.get("education_required_degree")
    if edu_deg is not None:
        edu_deg = str(edu_deg).lower().strip() if edu_deg else None

    edu_field = data.get("education_required_field")
    if edu_field is not None:
        edu_field = str(edu_field).strip() if edu_field else None

    efq = data.get("education_field_qualified")
    if efq is not None and not isinstance(efq, bool):
        efq = None

    visa = data.get("visa_sponsorship_required")
    if visa not in ("true", "false", "unknown") and visa is not None:
        visa = str(visa).lower()
        if visa not in ("true", "false", "unknown"):
            visa = "unknown"
    if visa is None:
        visa = "unknown"

    req = data.get("required_skills") or []
    nice = data.get("nice_to_have_skills") or []
    if not isinstance(req, list):
        req = []
    if not isinstance(nice, list):
        nice = []
    req = normalize_skills_list([str(x) for x in req], aliases)
    nice = normalize_skills_list([str(x) for x in nice], aliases)
    nice = [s for s in nice if s not in set(req)]

    jd_inc = data.get("jd_incomplete")
    if not isinstance(jd_inc, bool):
        jd_inc = len(req) == 0 and len(nice) == 0 and yoe is None

    other_notes = data.get("other_notes")
    if other_notes is not None:
        other_notes = str(other_notes).strip() or None

    logger.info(
        "[extractor/llm] Extraction complete | job_id=%s | "
        "skills_req=%s | skills_nth=%s",
        jid,
        len(req),
        len(nice),
    )
    return {
        "extracted_yoe": yoe,
        "extracted_salary_min": sal,
        "education_req_degree": edu_deg,
        "education_req_field": edu_field,
        "education_field_qualified": efq,
        "visa_req": visa,
        "required_skills": req,
        "nice_to_have_skills": nice,
        "other_notes": other_notes,
        "jd_incomplete": jd_inc,
        "_step_b_matching_mode": "llm",
    }


async def record_skill_candidates(
    db: AsyncSession,
    required_skills: list[str],
    nice_to_have_skills: list[str],
) -> None:
    """
    Upsert extracted skill strings into skill_candidates (caller must hold db_lock).
    """
    from datetime import datetime, timezone

    from sqlalchemy import select

    from matching.normaliser import skill_in_alias_lookup
    from models.skill_candidate import SkillCandidate

    now = datetime.now(timezone.utc)
    all_skills = [(s, "req") for s in (required_skills or [])] + [
        (s, "nth") for s in (nice_to_have_skills or [])
    ]

    for raw_skill, skill_type in all_skills:
        if not raw_skill or not str(raw_skill).strip():
            continue
        skill_name = str(raw_skill).strip()
        in_aliases = skill_in_alias_lookup(skill_name)

        result = await db.execute(
            select(SkillCandidate).where(SkillCandidate.skill_name == skill_name)
        )
        existing = result.scalar_one_or_none()

        if existing:
            existing.count += 1
            if skill_type == "req":
                existing.req_count += 1
            else:
                existing.nth_count += 1
            existing.last_seen = now
            existing.in_aliases = in_aliases
        else:
            db.add(
                SkillCandidate(
                    skill_name=skill_name,
                    count=1,
                    req_count=1 if skill_type == "req" else 0,
                    nth_count=0 if skill_type == "req" else 1,
                    in_aliases=in_aliases,
                    status="pending",
                    first_seen=now,
                    last_seen=now,
                )
            )

    await db.flush()
