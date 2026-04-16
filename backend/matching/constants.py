"""Extraction constants for Step B (JD extraction)."""

NTH_SECTION_MARKERS: list[str] = [
    "nice to have",
    "nice-to-have",
    "preferred",
    "bonus",
    "asset",
    "would be great",
    "plus if",
    "not required but",
    "an asset",
    "considered an asset",
    "a plus",
    "is a plus",
]

YOE_PATTERNS: list[str] = [
    r"(\d+)\+?\s*years?\s+of\s+experience",
    r"(\d+)\+?\s*years?\s+experience",
    r"minimum\s+(\d+)\s+years?",
    r"at\s+least\s+(\d+)\s+years?",
    r"(\d+)\s*[-–]\s*(\d+)\s*years?",
]

SPONSORSHIP_DENY_PHRASES: tuple[str, ...] = (
    "no sponsorship",
    "no visa sponsorship",
    "cannot sponsor",
    "unable to sponsor",
    "must be authorized",
    "must be legally authorized",
    "citizens only",
    "permanent residents only",
    "visa sponsorship is not available",
    "sponsorship is not available",
    "we are unable to provide sponsorship",
    "not able to sponsor",
    "does not offer sponsorship",
    "sponsorship will not be provided",
    "no work permit support",
    "no immigration support",
    "no relocation or visa assistance",
    "we do not support work permits",
    "we do not provide work authorization",
    "not in a position to sponsor",
)

SPONSORSHIP_OFFER_PHRASES: tuple[str, ...] = (
    "visa sponsorship available",
    "we sponsor",
    "sponsorship provided",
    "work permit supported",
    "we support work permits",
    "visa support provided",
    "we provide work authorization",
)

EDUCATION_PATTERNS: dict[str, list[str]] = {
    "phd": [r"ph\.?d", r"doctorate"],
    "master": [r"master'?s?", r"m\.sc", r"meng", r"mba"],
    "bachelor": [r"bachelor'?s?", r"b\.sc", r"beng", r"undergraduate"],
    "none": [r"no degree", r"degree not required", r"degree is not required"],
}

# OpenAI model for Step B JD extraction (`matching.extractor.llm_extract_jd`); logs tag this value.
MATCHING_MODEL = "gpt-4o-mini"

# OpenAI model for Step D LLM scoring (`matching.llm_scorer.llm_score_job`).
LLM_SCORE_MODEL = "gpt-4o-mini"
