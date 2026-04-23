"""Step D — LLM scoring for ambiguous CPU-scored jobs."""

from __future__ import annotations

import json
import re
import time
from typing import Any

from openai import AsyncOpenAI

from core.trace import JhaTrace, emit_llm_trace_event
from matching.constants import LLM_SCORE_MODEL
from matching.normaliser import normalise_list
from models.scraped_job import ScrapedJob


def _coerce_skill_list(raw: object) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw if x is not None and str(x).strip()]
    if isinstance(raw, dict):
        out: list[str] = []
        for v in raw.values():
            if isinstance(v, list):
                out.extend(str(x) for x in v if x is not None and str(x).strip())
            elif v is not None and str(v).strip():
                out.append(str(v))
        return out
    return []


def _parse_json_object(raw: str) -> dict[str, Any]:
    t = raw.strip()
    if t.startswith("```"):
        parts = t.split("```")
        if len(parts) >= 2:
            t = parts[1]
            if t.lstrip().startswith("json"):
                t = t.lstrip()[4:].lstrip()
    t = t.strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", t)
        if m:
            return json.loads(m.group(0))
        raise


def build_llm_score_prompt(job: ScrapedJob, profile: dict) -> str:
    ext = profile.get("_extracted") or {}
    raw_skills = (ext.get("skills") or []) + (profile.get("extra_skills") or [])
    if isinstance(raw_skills, dict):
        raw_skills = list(raw_skills.values())
    if not isinstance(raw_skills, list):
        raw_skills = []
    profile_skills = normalise_list(
        [str(x) for x in raw_skills if x is not None and str(x).strip()],
    )
    required_norm = normalise_list(_coerce_skill_list(job.required_skills))
    nth_norm = normalise_list(_coerce_skill_list(job.nice_to_have_skills))
    gap_list = [s for s in required_norm if s not in set(profile_skills)] or ["none"]

    work = profile.get("work_experience") or []
    if isinstance(work, list):
        last_2_titles = [
            str(e.get("title") or "")
            for e in sorted(
                [x for x in work if isinstance(x, dict)],
                key=lambda e: str(e.get("start_date") or ""),
                reverse=True,
            )[:2]
        ]
        last_2_titles = [t for t in last_2_titles if t]
    else:
        last_2_titles = []

    fit_pct = round((job.fit_score or 0) * 100)
    cov_pct = round((job.req_coverage or 0) * 100)
    yoe_prof = ext.get("yoe", "unknown")

    return f"""You are a hiring manager reviewing a candidate for this role.
Be calibrated and realistic — not optimistic. Assume a competitive market.

ROLE (from JD):
  yoe required:    {job.extracted_yoe if job.extracted_yoe is not None else "not specified"}
  required skills: {", ".join(required_norm) or "none extracted"}
  nice to have:    {", ".join(nth_norm) or "none"}

CANDIDATE:
  skills:         {", ".join(profile_skills) or "none"}
  yoe:            {yoe_prof}
  recent titles:  {", ".join(last_2_titles) or "not specified"}
  pre-score:      fit={fit_pct}%, required coverage={cov_pct}%
  skill gaps:     {", ".join(gap_list)}

EVALUATION — reason through these steps before answering:

Step 1 — Gap assessment:
  For each skill in skill gaps, classify adjacency:
    trivial (<1 week):   directly adjacent skill exists in candidate's profile
    easy (1-4 weeks):    same domain, different tool
    medium (1-3 months): related domain, different paradigm
    hard (3+ months):    genuinely new territory
  Be conservative. Only trivial/easy if candidate has demonstrable adjacent depth.

Step 2 — Overall judgment:
  Would you advance this candidate to a phone screen?

Return a JSON object (no text outside the JSON):
{{
  "match_level":   "strong_match | possible_match | stretch_match | weak_match",
  "match_reason":  "2-3 sentences. Name skills that match. Name biggest gap and whether it is a dealbreaker.",
  "blocking_gap":  "skill name or null",
  "gap_adjacency": [{{"skill": "Kubernetes", "classification": "trivial|easy|medium|hard"}}],
  "confidence":    "high | medium | low"
}}

Definitions:
  strong_match:   Would advance with high confidence
  possible_match: Would likely advance; gap(s) manageable
  stretch_match:  Might advance if candidate pool is thin; meaningful gap(s)
  weak_match:     Would not advance; fundamental gap or seniority mismatch"""


async def llm_score_job(
    job: ScrapedJob,
    profile: dict,
    config: dict,
    client: AsyncOpenAI,
    llm_trace_sink: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Returns keys: match_level, match_reason, blocking_gap, gap_adjacency, confidence.
    """
    prompt = build_llm_score_prompt(job, profile)
    t0 = time.monotonic()
    token_in: int | None = None
    token_out: int | None = None
    outcome = "ok"
    parse_ok = True
    error_class: str | None = None
    error_msg: str | None = None
    match_level_out: str | None = None

    if llm_trace_sink is None:
        JhaTrace.emit(
            "llm_score_start",
            {
                "stage": "llm_score",
                "job_id": str(job.id),
                "model": LLM_SCORE_MODEL,
                "prompt_len": len(prompt),
            },
        )

    try:
        msg = await client.chat.completions.create(
            model=LLM_SCORE_MODEL,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            timeout=120.0,
        )
        if hasattr(msg, "usage") and msg.usage:
            token_in = getattr(msg.usage, "prompt_tokens", None)
            token_out = getattr(msg.usage, "completion_tokens", None)
        raw_text = (msg.choices[0].message.content or "").strip()
        result = _parse_json_object(raw_text)

        valid_levels = {"strong_match", "possible_match", "stretch_match", "weak_match"}
        level = result.get("match_level")
        if level not in valid_levels:
            raise ValueError(f"Invalid match_level: {level!r}")

        bg = result.get("blocking_gap")
        if bg is not None and isinstance(bg, str) and bg.lower() in ("null", "none", ""):
            bg = None

        ga = result.get("gap_adjacency")
        if ga is None:
            ga = []
        if not isinstance(ga, list):
            ga = []

        conf = result.get("confidence")
        if conf not in ("high", "medium", "low"):
            conf = "medium"

        match_level_out = level
        return {
            "match_level": level,
            "match_reason": str(result.get("match_reason") or "").strip(),
            "blocking_gap": bg,
            "gap_adjacency": ga,
            "confidence": conf,
        }
    except Exception as e:
        outcome = "fail"
        parse_ok = False
        error_class = type(e).__name__
        error_msg = str(e)[:500]
        raise
    finally:
        if llm_trace_sink is not None:
            llm_trace_sink.append(
                {
                    "duration_ms": int((time.monotonic() - t0) * 1000),
                    "token_in": token_in,
                    "token_out": token_out,
                    "outcome": outcome,
                    "parse_ok": parse_ok,
                    "error_class": error_class,
                    "error_msg": error_msg,
                    "model": LLM_SCORE_MODEL,
                    "match_level": match_level_out,
                }
            )
        else:
            emit_llm_trace_event(
                phase="llm_score_done",
                model=LLM_SCORE_MODEL,
                t0_monotonic=t0,
                job_id=str(job.id),
                outcome=outcome,
                parse_ok=parse_ok,
                retries=0,
                token_in=token_in,
                token_out=token_out,
                error_class=error_class,
                error_msg=error_msg,
                extra={"match_level": match_level_out} if match_level_out else None,
            )
