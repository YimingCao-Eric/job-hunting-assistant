"""Step A: hard gates (CPU-only, pure functions)."""

from __future__ import annotations

from langdetect import LangDetectException, detect

DEGREE_ORDER = {"none": 0, "bachelor": 1, "master": 2, "phd": 3}
YOE_GATE_TOLERANCE = 1.0


def language_gate_jd(job_description: str | None, config: dict) -> str | None:
    """
    Returns 'language' if JD language is not in config allowed_languages.
    Empty JD: pass (cannot detect). LangDetectException: pass.
    """
    jd = job_description or ""
    if not jd.strip():
        return None
    try:
        lang = detect(jd)
    except LangDetectException:
        return None
    allowed = list(config.get("allowed_languages") or ["en"])
    if lang not in allowed:
        return "language"
    return None


def _normalise_degree(raw: str | None) -> str:
    """Map raw profile (or JD) degree strings to canonical DEGREE_ORDER keys."""
    if not raw:
        return "none"
    r = str(raw).lower().strip()
    if any(x in r for x in ("phd", "ph.d", "doctor")):
        return "phd"
    if any(x in r for x in ("master", "msc", "m.sc", "meng", "mba")):
        return "master"
    if any(x in r for x in ("bachelor", "bsc", "b.sc", "beng", "undergrad")):
        return "bachelor"
    return "none"


def run_hard_gates(extracted: dict, profile: dict, config: dict) -> str | None:
    """
    Run all hard gates in order. Return the first failing gate name,
    or None if all pass.

    Parameters:
        extracted: Step B fields (extracted_yoe, extracted_salary_min,
            education_req_degree, education_field_qualified, visa_req).
        profile: profile.json dict (_extracted.yoe, education[].degree).
        config: config dict (salary_min, needs_sponsorship).

    Returns:
        None, or "yoe_gate" | "salary_gate" | "education_gate" | "visa_gate".
    """
    # Gate 1 — YOE
    yoe_required = extracted.get("extracted_yoe")
    profile_yoe = profile.get("_extracted", {}).get("yoe")
    if yoe_required is not None:
        profile_y = float(profile_yoe) if profile_yoe is not None else 0.0
        if (float(yoe_required) - profile_y) > YOE_GATE_TOLERANCE:
            return "yoe_gate"

    # Gate 2 — Salary
    salary_min_config = config.get("salary_min", 0) or 0
    salary_min_job = extracted.get("extracted_salary_min")
    if salary_min_config and salary_min_job is not None:
        if float(salary_min_job) < float(salary_min_config):
            return "salary_gate"

    # Gate 3 — Education
    req_degree = extracted.get("education_req_degree")
    req_norm = str(req_degree).lower().strip() if req_degree is not None else ""
    if req_norm and req_norm != "none":
        edu_entries = profile.get("education") or []
        profile_max = max(
            (
                DEGREE_ORDER.get(_normalise_degree(e.get("degree") if isinstance(e, dict) else None), 0)
                for e in edu_entries
            ),
            default=0,
        )
        canon_req = _normalise_degree(req_norm)
        req_level = DEGREE_ORDER.get(canon_req, 0)
        if profile_max < req_level:
            return "education_gate"

    field_qualified = extracted.get("education_field_qualified")
    if field_qualified is False:
        return "education_gate"

    # Gate 4 — Visa
    needs_sponsorship = bool(config.get("needs_sponsorship", False))
    if needs_sponsorship:
        visa = extracted.get("visa_req")
        if visa == "false":
            return "visa_gate"

    return None
