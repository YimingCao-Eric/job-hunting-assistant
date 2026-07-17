"""Unit tests for the per-site canonical projection (feature 031 filter attributes).

No database, no HTTP, no container services -- the projection is pure functions over a
params dict, exactly as its module docstring promises. Run it anywhere the backend
imports:

    docker compose exec -T backend python unit_test_scraped_job_projection.py

Style follows the smoke tests (ok/fail + non-zero exit) rather than pytest: this project
has no test framework, and these assertions are the same kind of executable contract the
smoke suite is, minus the I/O.

What is worth testing here is NOT "does the mapping table contain FULL_TIME" -- that is
tautological. It is the handful of decisions a future reader is most likely to
"simplify" into a bug:

  - `Other` yields NULL WITHOUT a warning, while an unknown token warns. Collapsing
    those two is the easiest possible regression, and it silently destroys the warning
    review the mapping's correctness depends on.
  - Precedence beats payload order. A dict/list-order-dependent implementation passes
    every single-value test and fails silently on real data.
  - An unrecognized token must never outrank a recognized one.
  - salary_disclosed False is a claim, never a fallback for "unreadable".
  - NULL means "the site did not say" -- never "no", never an empty string.
"""

from __future__ import annotations

import logging
import sys

from core.scraped_job_projection import (
    CANONICAL_COLS,
    EMPLOYMENT_PRECEDENCE,
    WORKPLACE_PRECEDENCE,
    _EMPLOYMENT_VOCAB,
    _norm_token,
    _SALARY_EMPLOYER,
    _SALARY_ESTIMATE,
    _UNMAPPABLE,
    _WORKPLACE_VOCAB,
    derive_salary_disclosed,
    join_education_labels,
    normalize_employment_type,
    normalize_language,
    normalize_workplace_type,
    project_to_canonical,
)

FAILED = False


def ok(msg: str) -> None:
    print(f"[OK] {msg}")


def fail(msg: str) -> None:
    global FAILED
    FAILED = True
    print(f"[FAIL] {msg}", file=sys.stderr)


def check(actual, expected, msg: str) -> None:
    if actual == expected:
        ok(msg)
    else:
        fail(f"{msg} -- expected {expected!r}, got {actual!r}")


class CaptureWarnings(logging.Handler):
    """Capture projection warnings so 'warns'/'does not warn' is asserted, not assumed.

    The distinction between a silent NULL and a warning NULL is invisible in the return
    value -- both are None. It can only be tested here.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record.getMessage())

    def __enter__(self) -> "CaptureWarnings":
        logging.getLogger("core.scraped_job_projection").addHandler(self)
        return self

    def __exit__(self, *exc) -> None:
        logging.getLogger("core.scraped_job_projection").removeHandler(self)


# --- vocabulary invariants ---------------------------------------------------------


def test_every_vocab_key_is_reachable_through_the_normalizer() -> None:
    """No lookup key may be unmatchable. This guards a whole bug class.

    Lookups happen on the OUTPUT of _norm_token, so any key that is not a fixed point of
    _norm_token can never be hit -- it is dead config that silently nulls real postings
    and warns about them, which reads as vocabulary drift rather than as our bug.

    This is not hypothetical: the first run of these tests caught exactly that. The
    workplace table listed only ONSITE, while LinkedIn's real label "On-site" folds to
    ON_SITE -- so every LinkedIn on-site posting would have been nulled and warned.
    """
    tables = {
        "_EMPLOYMENT_VOCAB": _EMPLOYMENT_VOCAB.keys(),
        "_WORKPLACE_VOCAB": _WORKPLACE_VOCAB.keys(),
        "_UNMAPPABLE": _UNMAPPABLE,
        "_SALARY_EMPLOYER": _SALARY_EMPLOYER,
        "_SALARY_ESTIMATE": _SALARY_ESTIMATE,
    }
    for name, keys in tables.items():
        unreachable = [k for k in keys if _norm_token(k) != k]
        if unreachable:
            fail(f"{name}: keys unreachable via _norm_token (dead config): {unreachable}")
        else:
            ok(f"{name}: every key is reachable through the normalizer")


def test_precedence_covers_the_whole_vocabulary() -> None:
    """A canonical token absent from precedence could be mapped but never selected."""
    employment = set(_EMPLOYMENT_VOCAB.values())
    missing = employment - set(EMPLOYMENT_PRECEDENCE)
    check(missing, set(), "every employment token appears in EMPLOYMENT_PRECEDENCE")

    workplace = set(_WORKPLACE_VOCAB.values())
    missing = workplace - set(WORKPLACE_PRECEDENCE)
    check(missing, set(), "every workplace token appears in WORKPLACE_PRECEDENCE")


def test_real_site_labels_normalize_onto_the_vocabulary() -> None:
    """The labels the three sites actually ship, end to end through normalization.

    Written as literal site spellings rather than pre-normalized tokens, because the
    spelling is where this breaks.
    """
    for label, expected in [
        ("Full-time", "FULL_TIME"),     # LinkedIn / Indeed
        ("Part-time", "PART_TIME"),     # LinkedIn / Indeed
        ("FULL_TIME", "FULL_TIME"),     # Glassdoor JSON-LD
        ("PART_TIME", "PART_TIME"),
        ("CONTRACTOR", "CONTRACT"),     # Glassdoor JSON-LD
        ("INTERN", "INTERNSHIP"),
        ("Internship", "INTERNSHIP"),
        ("Temporary", "TEMPORARY"),
        ("Volunteer", "VOLUNTEER"),
    ]:
        check(normalize_employment_type(label, site="test"), expected,
              f"employment label {label!r} -> {expected}")

    for label, expected in [
        ("Remote", "REMOTE"),           # LinkedIn
        ("On-site", "ONSITE"),          # LinkedIn -- folds to ON_SITE
        ("Hybrid", "HYBRID"),           # LinkedIn
        ("REMOTE", "REMOTE"),           # Glassdoor (attested live)
        ("ONSITE", "ONSITE"),
    ]:
        check(normalize_workplace_type(label, site="test"), expected,
              f"workplace label {label!r} -> {expected}")


def test_real_site_labels_emit_no_warnings() -> None:
    """SC-009: normal postings must be silent, or the warning review is worthless."""
    with CaptureWarnings() as cap:
        for label in ("Full-time", "Part-time", "Contract", "Temporary",
                      "Internship", "Volunteer", "Other"):
            normalize_employment_type(label, site="test")
        for label in ("Remote", "On-site", "Hybrid"):
            normalize_workplace_type(label, site="test")
    check(cap.records, [], "no warning from any label a site normally sends")


# --- employment_type ---------------------------------------------------------------


def test_employment_type_vocabulary() -> None:
    check(normalize_employment_type("Full-time", site="linkedin"), "FULL_TIME",
          "LinkedIn 'Full-time' -> FULL_TIME")
    check(normalize_employment_type(["Full-time"], site="indeed"), "FULL_TIME",
          "Indeed ['Full-time'] -> FULL_TIME (same token as LinkedIn)")
    check(normalize_employment_type(["FULL_TIME"], site="glassdoor"), "FULL_TIME",
          "Glassdoor ['FULL_TIME'] -> FULL_TIME (same token again)")
    check(normalize_employment_type("INTERN", site="glassdoor"), "INTERNSHIP",
          "'INTERN' -> INTERNSHIP")
    check(normalize_employment_type("Contractor", site="glassdoor"), "CONTRACT",
          "'Contractor' -> CONTRACT")
    check(normalize_employment_type(None, site="linkedin"), None,
          "absent employment status -> None")


def test_permanent_is_a_tenure_axis_ranked_below_hours() -> None:
    """PERMANENT, resolved from the 2026-07-17 scan (Indeed sends "Permanent").

    It is a TENURE statement, not an hours statement -- a permanent part-time job exists
    -- so it gets its own token rather than being folded into FULL_TIME, which would
    assert hours the source never stated.

    Its precedence rank is the whole design: ranked below the hours tokens, so the
    common ["Full-time", "Permanent"] pairing still yields FULL_TIME and PERMANENT
    surfaces only when it is the sole signal. Raising it above FULL_TIME would silently
    re-label a large slice of the Indeed corpus.
    """
    with CaptureWarnings() as cap:
        check(normalize_employment_type(["Permanent"], site="indeed"), "PERMANENT",
              "['Permanent'] alone -> PERMANENT (no longer an unknown token)")
        check(normalize_employment_type(["Full-time", "Permanent"], site="indeed"),
              "FULL_TIME",
              "['Full-time','Permanent'] -> FULL_TIME (hours outrank tenure)")
        check(normalize_employment_type(["Permanent", "Full-time"], site="indeed"),
              "FULL_TIME", "reversed order -> still FULL_TIME (precedence, not order)")
        check(normalize_employment_type(["Part-time", "Permanent"], site="indeed"),
              "PART_TIME", "permanent PART-time -> PART_TIME, not FULL_TIME")
    check(cap.records, [], "'Permanent' no longer warns -- it is mapped, not unknown")

    # Guard the rank itself: a future edit that promotes PERMANENT would quietly change
    # what a large share of Indeed rows report.
    if EMPLOYMENT_PRECEDENCE.index("PERMANENT") <= EMPLOYMENT_PRECEDENCE.index("FULL_TIME"):
        fail("PERMANENT must rank BELOW FULL_TIME or the common combo re-labels")
    elif EMPLOYMENT_PRECEDENCE.index("PERMANENT") <= EMPLOYMENT_PRECEDENCE.index("PART_TIME"):
        fail("PERMANENT must rank BELOW PART_TIME (permanent part-time is part-time)")
    else:
        ok("PERMANENT ranks below the hours tokens in EMPLOYMENT_PRECEDENCE")


def test_employment_vocabulary_is_closed_at_seven() -> None:
    """The vocabulary is closed. Growth is a spec decision, not an implementation one."""
    check(set(EMPLOYMENT_PRECEDENCE),
          {"FULL_TIME", "PART_TIME", "CONTRACT", "TEMPORARY", "INTERNSHIP", "PERMANENT",
           "VOLUNTEER"},
          "employment vocabulary is exactly the seven canonical tokens")
    check(len(EMPLOYMENT_PRECEDENCE), 7, "seven tokens, no duplicates")


def test_employment_precedence_beats_payload_order() -> None:
    """The same values in any order must yield the same token (SC-003a)."""
    forward = normalize_employment_type(["Full-time", "Part-time"], site="indeed")
    reverse = normalize_employment_type(["Part-time", "Full-time"], site="indeed")
    check(forward, "FULL_TIME", "Full-time/Part-time -> FULL_TIME (higher precedence)")
    check(reverse, "FULL_TIME", "reversed order -> FULL_TIME (order-independent)")
    check(forward, reverse, "selection does not depend on payload order")

    check(normalize_employment_type(["Volunteer", "Contract"], site="indeed"), "CONTRACT",
          "Volunteer/Contract -> CONTRACT (precedence, not first-wins)")


def test_other_is_silent_null_but_unknown_warns() -> None:
    """The three-way classification. Collapsing these two is the likeliest regression."""
    with CaptureWarnings() as cap:
        result = normalize_employment_type("Other", site="linkedin")
    check(result, None, "'Other' -> None (recognized, maps to no token)")
    check(cap.records, [], "'Other' emits NO warning -- the site answered correctly")

    with CaptureWarnings() as cap:
        result = normalize_employment_type("Per-diem", site="glassdoor")
    check(result, None, "unknown 'Per-diem' -> None")
    check(len(cap.records), 1, "unknown token emits exactly one warning")
    if cap.records and "projection_unknown_employment_type" not in cap.records[0]:
        fail(f"warning should name the event, got {cap.records[0]!r}")
    elif cap.records and "Per-diem" not in cap.records[0]:
        fail(f"warning should carry the raw value, got {cap.records[0]!r}")
    else:
        ok("warning names projection_unknown_employment_type and the raw value")


def test_unrecognized_never_outranks_recognized() -> None:
    with CaptureWarnings() as cap:
        result = normalize_employment_type(["Per-diem", "Full-time"], site="indeed")
    check(result, "FULL_TIME", "unknown alongside recognized -> the recognized one wins")
    check(len(cap.records), 1, "only the unrecognized sibling warns")

    with CaptureWarnings() as cap:
        result = normalize_employment_type(["Other", "Part-time"], site="linkedin")
    check(result, "PART_TIME", "'Other' does not suppress a recognized sibling")
    check(cap.records, [], "'Other' beside a recognized value still does not warn")


def test_all_unrecognized_yields_null() -> None:
    with CaptureWarnings() as cap:
        result = normalize_employment_type(["Per-diem", "Commission"], site="indeed")
    check(result, None, "every value unrecognized -> None")
    check(len(cap.records), 2, "each unrecognized value warns once")


def test_deliberately_unmapped_tokens_warn_rather_than_guess() -> None:
    """FR-005c: these remain unmapped on purpose, pending evidence from a real scan.

    If someone maps one of these, this test failing is the intended alarm: the mapping
    table and the spec must be updated together, with evidence.

    PERMANENT was on this list and has been REMOVED -- it now has that evidence (the
    2026-07-17 scan) and its own token. That is the process working, not a weakening of
    it: unmapped -> warn -> review against real data -> decide -> spec + test together.
    The remaining five have no such evidence yet and stay unmapped.
    """
    for token in ("FREELANCE", "PER_DIEM", "APPRENTICESHIP",
                  "COMMISSION", "NEW_GRAD"):
        with CaptureWarnings() as cap:
            result = normalize_employment_type(token, site="indeed")
        if result is not None:
            fail(f"{token} is deliberately unmapped but returned {result!r}")
        elif len(cap.records) != 1:
            fail(f"{token} should warn exactly once, got {len(cap.records)}")
        else:
            ok(f"{token} -> None + warning (unmapped by design, not by omission)")


# --- workplace_type ----------------------------------------------------------------


def test_linkedin_workplace_urn_map() -> None:
    """LinkedIn's REAL shape, from the 2026-07-17 scan (467 rows).

    Not a list of labels, and not a resolution map of localizedName objects: it is a
    URN-keyed map whose values are the same URN strings.

        {"*urn:li:fs_workplaceType:2": "urn:li:fs_workplaceType:2"}

    The 031 fixture assumed localizedName labels and was simply wrong -- which is
    exactly what the warning review existed to catch. Mapping the enum codes is also
    strictly better than mapping labels: URNs are locale-proof, where "Remote" is not.
    """
    def urn(code: int):
        return {f"*urn:li:fs_workplaceType:{code}": f"urn:li:fs_workplaceType:{code}"}

    with CaptureWarnings() as cap:
        check(normalize_workplace_type(urn(1), site="linkedin"), "ONSITE",
              "LinkedIn URN workplaceType:1 -> ONSITE")
        check(normalize_workplace_type(urn(2), site="linkedin"), "REMOTE",
              "LinkedIn URN workplaceType:2 -> REMOTE (the live-attested value)")
        check(normalize_workplace_type(urn(3), site="linkedin"), "HYBRID",
              "LinkedIn URN workplaceType:3 -> HYBRID")
    check(cap.records, [], "the real LinkedIn URN shape emits no warnings")


def test_workplace_type_vocabulary_and_precedence() -> None:
    check(normalize_workplace_type(["Remote"], site="linkedin"), "REMOTE",
          "['Remote'] label -> REMOTE")
    check(normalize_workplace_type(["REMOTE"], site="glassdoor"), "REMOTE",
          "Glassdoor ['REMOTE'] -> REMOTE (the one attested live value)")
    check(normalize_workplace_type(["On-site"], site="linkedin"), "ONSITE",
          "'On-site' -> ONSITE")
    check(normalize_workplace_type("Work from home", site="linkedin"), "REMOTE",
          "'Work from home' -> REMOTE")
    # Keeps _label_of's dict path covered. LinkedIn does not send this shape, but the
    # unwrapping is live code and an untested branch is where the next bug hides.
    check(normalize_workplace_type({"u": {"localizedName": "Remote"}}, site="linkedin"),
          "REMOTE", "resolution map of localizedName objects still unwraps -> REMOTE")

    forward = normalize_workplace_type(["Remote", "Hybrid"], site="linkedin")
    reverse = normalize_workplace_type(["Hybrid", "Remote"], site="linkedin")
    check(forward, "REMOTE", "Remote/Hybrid -> REMOTE (precedence favours remote)")
    check(forward, reverse, "workplace selection is order-independent")

    check(normalize_workplace_type([], site="glassdoor"), None,
          "empty list is absence -> None")


def test_empty_and_blank_are_absence_not_warnings() -> None:
    with CaptureWarnings() as cap:
        check(normalize_workplace_type([], site="glassdoor"), None, "[] -> None")
        check(normalize_workplace_type(None, site="glassdoor"), None, "None -> None")
        check(normalize_employment_type("   ", site="linkedin"), None, "blank -> None")
    check(cap.records, [], "absence never warns -- the site behaved normally")


# --- salary_disclosed --------------------------------------------------------------


def test_extraction_is_employer_disclosed() -> None:
    """EXTRACTION resolved from the 2026-07-17 scan -- Indeed's entire salary population.

    Indeed parsed the pay out of the job description: employer-authored prose. The
    tri-state rule decides this, rather than taste. False means "the site estimated
    this pay", which EXTRACTION plainly is not -- Indeed computed nothing. So False is
    ruled out. That leaves True or None, and None would strand every Indeed salary as
    "provenance unknown" when the provenance is in fact known: the employer wrote it.

    salary_disclosed encodes PROVENANCE, not parse reliability. "The employer stated
    this, in prose" is still the employer stating it.

    This reverses the placeholder None asserted while EXTRACTION was unmapped. The
    reversal is the warning mechanism working exactly as designed: unmapped -> warn ->
    review with real data -> decide.
    """
    with CaptureWarnings() as cap:
        result = derive_salary_disclosed("EXTRACTION", site="indeed")
    check(result, True, "Indeed 'EXTRACTION' -> True (employer-authored prose)")
    if result is False:
        fail("EXTRACTION must never be False -- Indeed estimated nothing")
    check(cap.records, [], "'EXTRACTION' no longer warns -- it is resolved, not unknown")


def test_salary_disclosed_positive_evidence_only() -> None:
    check(derive_salary_disclosed("EMPLOYER", site="indeed"), True,
          "Indeed 'EMPLOYER' -> True")
    check(derive_salary_disclosed("INDEED_ESTIMATE", site="indeed"), False,
          "Indeed 'INDEED_ESTIMATE' -> False")
    check(derive_salary_disclosed("EMPLOYER_PROVIDED", site="glassdoor"), True,
          "Glassdoor 'EMPLOYER_PROVIDED' -> True")
    check(derive_salary_disclosed("GLASSDOOR_ESTIMATE", site="glassdoor"), False,
          "Glassdoor 'GLASSDOOR_ESTIMATE' -> False")
    check(derive_salary_disclosed(None, site="indeed"), None,
          "absent salary source -> None (not False)")


def test_unrecognized_salary_source_is_null_never_false() -> None:
    """False claims 'the site estimated this'. An unreadable token cannot claim it."""
    with CaptureWarnings() as cap:
        result = derive_salary_disclosed("SOME_NEW_SOURCE", site="indeed")
    if result is False:
        fail("unrecognized salary source must NOT resolve to False -- that asserts "
             "the site published an estimate it never published")
    else:
        check(result, None, "unrecognized salary source -> None")
    check(len(cap.records), 1, "unrecognized salary source warns")


# --- language ----------------------------------------------------------------------


def test_language_shape_not_membership() -> None:
    check(normalize_language("en", site="indeed"), "en", "'en' -> en")
    check(normalize_language("EN", site="indeed"), "en", "'EN' -> en (lowercased)")
    check(normalize_language("en-US", site="indeed"), "en", "'en-US' -> en (subtag dropped)")
    check(normalize_language("en_US", site="indeed"), "en", "'en_US' -> en")
    check(normalize_language("fil", site="indeed"), "fil", "3-letter code accepted")
    check(normalize_language("  fr  ", site="indeed"), "fr", "whitespace trimmed")
    check(normalize_language(None, site="indeed"), None, "absent -> None")

    # Membership is NOT checked: no allow-list of real languages.
    check(normalize_language("zz", site="indeed"), "zz",
          "'zz' accepted -- shape is validated, not whether the language exists")


def test_language_bad_shape_warns() -> None:
    with CaptureWarnings() as cap:
        check(normalize_language("english", site="indeed"), None, "'english' -> None (too long)")
        check(normalize_language("e", site="indeed"), None, "'e' -> None (too short)")
        check(normalize_language("12", site="indeed"), None, "'12' -> None (not letters)")
    check(len(cap.records), 3, "each bad-shape value warns once")

    with CaptureWarnings() as cap:
        check(normalize_language("", site="indeed"), None, "'' -> None")
    check(cap.records, [], "empty is absence, not a bad shape -- no warning")


# --- education_requirements --------------------------------------------------------


def test_education_labels_join_keeps_everything() -> None:
    check(join_education_labels(["Bachelor's"]), "Bachelor's",
          "single label -> itself, no separator")
    check(join_education_labels(["Bachelor's", "Master's"]), "Bachelor's; Master's",
          "multiple labels joined with '; ' in source order, none dropped")
    check(join_education_labels(["Bachelor's", "  ", "Master's"]), "Bachelor's; Master's",
          "blank entries omitted from the join")
    check(join_education_labels([]), None, "empty list -> None")
    check(join_education_labels(["  ", ""]), None, "all-blank list is absence -> None")
    check(join_education_labels(None), None, "absent -> None")


def test_education_never_warns() -> None:
    with CaptureWarnings() as cap:
        join_education_labels(["anything at all", "¡weird!"])
        join_education_labels([])
    check(cap.records, [], "education is free text -- no vocabulary, so nothing to warn about")


# --- whole-row projection ----------------------------------------------------------


def _params(**overrides) -> dict:
    base = {"scan_run_id": "00000000-0000-0000-0000-000000000001",
            "job_url": "https://example.com/job/1"}
    base.update(overrides)
    return base


def test_projection_contract_holds_for_every_site() -> None:
    """The guard that makes CANONICAL_COLS and the INSERT unable to drift apart."""
    for site in ("linkedin", "indeed", "glassdoor"):
        row = project_to_canonical(
            site=site,
            params=_params(),
            source_row_id="00000000-0000-0000-0000-000000000002",
            scrape_time="2026-07-16T00:00:00Z",
        )
        check(sorted(row.keys()), sorted(CANONICAL_COLS),
              f"{site}: projection keys match CANONICAL_COLS exactly")
        for col in ("employment_type", "workplace_type", "language",
                    "education_requirements", "salary_disclosed"):
            if col not in row:
                fail(f"{site}: {col} missing from projection")
    ok("all five filter attributes present in every site's projection")


def test_empty_payload_yields_null_not_crash() -> None:
    """A site that says nothing must produce NULLs, never an exception (FR-013)."""
    for site in ("linkedin", "indeed", "glassdoor"):
        row = project_to_canonical(
            site=site,
            params=_params(),
            source_row_id="00000000-0000-0000-0000-000000000002",
            scrape_time="2026-07-16T00:00:00Z",
        )
        for col in ("employment_type", "workplace_type", "language",
                    "education_requirements", "salary_disclosed"):
            check(row[col], None, f"{site}: silent site -> {col} is None")


def test_linkedin_labels_win_and_conflict_warns() -> None:
    """Labels beat work_remote_allowed; the contradiction is surfaced, not resolved."""
    with CaptureWarnings() as cap:
        row = project_to_canonical(
            site="linkedin",
            params=_params(workplace_types_labels=["Remote"], work_remote_allowed=False),
            source_row_id="00000000-0000-0000-0000-000000000002",
            scrape_time="2026-07-16T00:00:00Z",
        )
    check(row["workplace_type"], "REMOTE", "LinkedIn labels win for workplace_type")
    check(row["remote"], False, "`remote` still reads work_remote_allowed -- unchanged")
    if not any("projection_workplace_remote_conflict" in r for r in cap.records):
        fail("a labels/boolean contradiction must warn")
    else:
        ok("contradiction warns under its own event, not projection_unknown_*")

    # Agreement must stay quiet, or the review drowns.
    with CaptureWarnings() as cap:
        project_to_canonical(
            site="linkedin",
            params=_params(workplace_types_labels=["Remote"], work_remote_allowed=True),
            source_row_id="00000000-0000-0000-0000-000000000002",
            scrape_time="2026-07-16T00:00:00Z",
        )
    check(cap.records, [], "labels agreeing with the boolean emits no warning")


def test_indeed_remote_boolean_maps_to_vocabulary() -> None:
    def workplace(remote_location):
        return project_to_canonical(
            site="indeed",
            params=_params(remote_location=remote_location),
            source_row_id="00000000-0000-0000-0000-000000000002",
            scrape_time="2026-07-16T00:00:00Z",
        )["workplace_type"]

    check(workplace(True), "REMOTE", "Indeed remote_location=True -> REMOTE")
    # Accepted mislabel: Indeed cannot express hybrid, so a hybrid posting reads ONSITE.
    check(workplace(False), "ONSITE", "Indeed remote_location=False -> ONSITE")
    check(workplace(None), None, "Indeed remote_location absent -> None")


def test_glassdoor_structured_employment_wins_outright() -> None:
    def employment(**kw):
        return project_to_canonical(
            site="glassdoor",
            params=_params(**kw),
            source_row_id="00000000-0000-0000-0000-000000000002",
            scrape_time="2026-07-16T00:00:00Z",
        )["employment_type"]

    check(employment(employment_type=["PART_TIME"], job_type=["Full-time"]), "PART_TIME",
          "structured field wins; header is ignored entirely (never merged)")
    check(employment(employment_type=[], job_type=["Full-time"]), "FULL_TIME",
          "empty structured list is absence -> header fallback fires")
    check(employment(employment_type=None, job_type=["Full-time"]), "FULL_TIME",
          "absent structured field -> header fallback fires")
    check(employment(employment_type=["OTHER"], job_type=["Full-time"]), None,
          "structured 'OTHER' is present and answered -> None, no fallback")


def test_glassdoor_education_fallback_and_blank_handling() -> None:
    def education(**kw):
        return project_to_canonical(
            site="glassdoor",
            params=_params(**kw),
            source_row_id="00000000-0000-0000-0000-000000000002",
            scrape_time="2026-07-16T00:00:00Z",
        )["education_requirements"]

    check(education(education_labels=["Bachelor's", "Master's"]), "Bachelor's; Master's",
          "labels win and are all kept")
    check(education(education_labels=[], experience_requirements_description="5 years"),
          "5 years", "no labels -> experience prose fallback (duplicates experience_level)")
    check(education(education_labels=[], experience_requirements_description="   "),
          None, "blank fallback is absence -> None, never an empty string")
    check(education(), None, "neither source -> None")


def test_glassdoor_duplication_is_real_and_expected() -> None:
    """FR-012a: the fallback deliberately writes one value into two columns.

    Asserted so the duplication is a recorded decision rather than a surprise -- and so
    that anyone "fixing" it has to come here and read why.
    """
    row = project_to_canonical(
        site="glassdoor",
        params=_params(experience_requirements_description="5+ years experience"),
        source_row_id="00000000-0000-0000-0000-000000000002",
        scrape_time="2026-07-16T00:00:00Z",
    )
    check(row["education_requirements"], row["experience_level"],
          "education_requirements duplicates experience_level on fallback (by design)")


def main() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for test in tests:
        test()
    if FAILED:
        print("\n[FAIL] scraped_job_projection unit tests FAILED", file=sys.stderr)
        sys.exit(1)
    print(f"\n[OK] all scraped_job_projection unit tests passed ({len(tests)} groups)")


if __name__ == "__main__":
    main()
