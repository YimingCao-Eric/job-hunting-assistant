"""Auto-scrape config validation. Source of truth for limits."""

from typing import Any

VALID_SITES = {"linkedin", "indeed", "glassdoor"}

LIMITS = {
    "min_cycle_interval_minutes": (1, 1440, 1),
    "inter_scan_delay_seconds": (5, 600, 30),
    "scan_timeout_minutes": (3, 30, 8),
    "max_consecutive_precheck_failures": (1, 100, 3),
    "max_consecutive_dead_session_cycles": (1, 1000, 24),
}

DERIVED_LIMITS = {
    "max_keywords": 10,
    "max_scans_per_cycle_hard": 30,
    "max_scans_per_cycle_warn": 15,
}


class ConfigValidationError(ValueError):
    """Raised when config violates a hard limit. .field_errors holds details."""

    def __init__(self, field_errors: dict[str, str]):
        self.field_errors = field_errors
        super().__init__("; ".join(f"{k}: {v}" for k, v in field_errors.items()))


def validate(config: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: dict[str, str] = {}
    warnings: list[str] = []

    for field, (lo, hi, _rec) in LIMITS.items():
        if field in config:
            v = config[field]
            if not isinstance(v, int):
                errors[field] = "must be an integer"
                continue
            if v < lo or v > hi:
                errors[field] = f"must be between {lo} and {hi}"

    sites = config.get("enabled_sites", [])
    if not isinstance(sites, list) or not sites:
        errors["enabled_sites"] = "must be a non-empty list"
    else:
        invalid = [s for s in sites if s not in VALID_SITES]
        if invalid:
            errors["enabled_sites"] = (
                f"invalid sites: {invalid}; must be from {sorted(VALID_SITES)}"
            )

    kws = config.get("keywords", [])
    if not isinstance(kws, list) or not kws:
        errors["keywords"] = "must be a non-empty list"
    elif len(kws) > DERIVED_LIMITS["max_keywords"]:
        errors["keywords"] = f"max {DERIVED_LIMITS['max_keywords']} keywords"
    elif any(not isinstance(k, str) or not k.strip() for k in kws):
        errors["keywords"] = "all keywords must be non-empty strings"

    if "enabled_sites" not in errors and "keywords" not in errors:
        scans_per_cycle = len(sites) * len(kws)
        if scans_per_cycle > DERIVED_LIMITS["max_scans_per_cycle_hard"]:
            errors["scans_per_cycle"] = (
                f"{len(kws)} keywords × {len(sites)} sites = {scans_per_cycle} scans/cycle, "
                f"max {DERIVED_LIMITS['max_scans_per_cycle_hard']}"
            )
        elif scans_per_cycle >= DERIVED_LIMITS["max_scans_per_cycle_warn"]:
            warnings.append(
                f"{len(kws)} keywords × {len(sites)} sites = {scans_per_cycle} scans/cycle. "
                f"Cycle time may be long (~{scans_per_cycle * 4} minutes/cycle estimated)."
            )

    if errors:
        raise ConfigValidationError(errors)

    return config, warnings


def get_limits() -> dict[str, Any]:
    return {
        "limits": {
            field: {"min": lo, "max": hi, "recommended": rec}
            for field, (lo, hi, rec) in LIMITS.items()
        },
        "derived_limits": {**DERIVED_LIMITS},
        "valid_sites": sorted(VALID_SITES),
    }
