"""Step C — CPU pre-score. Pure Python; no DB, async, or LLM."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from matching.normaliser import normalise_list


@dataclass
class ScoreResult:
    fit_score: float | None  # base req_coverage + NTH bonus; may exceed 1.0, or None
    req_coverage: float | None  # 0.0–1.0 or None (no required skills)
    match_level: str  # strong_match | stretch_match | weak_match
    match_reason: str  # human-readable explanation
    send_to_llm: bool  # True = forward to Step D
    matched_req: list[str]  # skills from required that matched profile
    gap_skills: list[str]  # required skills not in profile


def cpu_prescore(
    extracted: dict,
    profile_skills: list[str],
    config: dict[str, Any],
) -> ScoreResult:
    """
    Step C — CPU Pre-Score.

    Parameters:
        extracted: dict with keys required_skills, nice_to_have_skills
            (both are lists of strings, may be None or [])
        profile_skills: list of raw skill strings from profile
        config: dict with keys cpu_strong_threshold, cpu_binary_threshold,
            nth_bonus_weight, llm (bool)

    Returns:
        ScoreResult with fit_score, req_coverage, match_level,
        match_reason, send_to_llm, matched_req, gap_skills
    """
    STRONG_THRESHOLD = float(config.get("cpu_strong_threshold", 0.85))
    BINARY_THRESHOLD = float(config.get("cpu_binary_threshold", 0.50))
    NTH_BONUS_WEIGHT = float(config.get("nth_bonus_weight", 0.10))
    llm_mode = bool(config.get("llm", False))

    profile_norm = set(normalise_list(profile_skills))
    required_norm = normalise_list(extracted.get("required_skills") or [])
    nth_norm = normalise_list(extracted.get("nice_to_have_skills") or [])

    if required_norm:
        matched_req = [s for s in required_norm if s in profile_norm]
        gap_skills = [s for s in required_norm if s not in profile_norm]
        req_coverage = len(matched_req) / len(required_norm)
    else:
        matched_req = []
        gap_skills = []
        req_coverage = None

    if nth_norm:
        matched_nth = [s for s in nth_norm if s in profile_norm]
        nth_bonus = len(matched_nth) / len(nth_norm)
    else:
        matched_nth = []
        nth_bonus = 0.0

    if req_coverage is not None:
        fit_score = req_coverage + (nth_bonus * NTH_BONUS_WEIGHT)
    elif nth_norm:
        fit_score = nth_bonus
    else:
        fit_score = None

    if fit_score is None:
        if llm_mode:
            return ScoreResult(
                fit_score=None,
                req_coverage=None,
                match_level="stretch_match",
                match_reason="Insufficient JD skill data to score.",
                send_to_llm=True,
                matched_req=[],
                gap_skills=[],
            )
        return ScoreResult(
            fit_score=None,
            req_coverage=None,
            match_level="stretch_match",
            match_reason="Insufficient JD skill data to score.",
            send_to_llm=False,
            matched_req=[],
            gap_skills=[],
        )

    if fit_score == 0.0 and req_coverage == 0.0:
        req_list = ", ".join(required_norm[:8])
        suffix = "…" if len(required_norm) > 8 else ""
        return ScoreResult(
            fit_score=0.0,
            req_coverage=0.0,
            match_level="weak_match",
            match_reason=f"No required skill overlap. Required: {req_list}{suffix}",
            send_to_llm=False,
            matched_req=[],
            gap_skills=gap_skills,
        )

    if fit_score >= STRONG_THRESHOLD:
        if req_coverage is not None:
            matched_show = matched_req
            mid = f"{req_coverage:.0%} required skills matched. "
        else:
            matched_show = matched_nth
            mid = "no required skills in JD; "
        matched_str = ", ".join(matched_show[:6])
        suffix = "…" if len(matched_show) > 6 else ""
        return ScoreResult(
            fit_score=round(fit_score, 4),
            req_coverage=round(req_coverage, 4) if req_coverage is not None else None,
            match_level="strong_match",
            match_reason=(
                f"Auto: {fit_score:.0%} fit, {mid}"
                f"Matched: {matched_str}{suffix}"
            ),
            send_to_llm=False,
            matched_req=matched_req,
            gap_skills=gap_skills,
        )

    if llm_mode:
        return ScoreResult(
            fit_score=round(fit_score, 4),
            req_coverage=round(req_coverage, 4) if req_coverage is not None else None,
            match_level="stretch_match",
            match_reason=(
                f"Pre-score: {fit_score:.0%} fit, "
                f"{(req_coverage or 0.0):.0%} required skills matched."
            ),
            send_to_llm=True,
            matched_req=matched_req,
            gap_skills=gap_skills,
        )

    level = "stretch_match" if fit_score >= BINARY_THRESHOLD else "weak_match"
    return ScoreResult(
        fit_score=round(fit_score, 4),
        req_coverage=round(req_coverage, 4) if req_coverage is not None else None,
        match_level=level,
        match_reason=(
            f"CPU: {fit_score:.0%} fit, "
            f"{(req_coverage or 0.0):.0%} required skills matched."
        ),
        send_to_llm=False,
        matched_req=matched_req,
        gap_skills=gap_skills,
    )
