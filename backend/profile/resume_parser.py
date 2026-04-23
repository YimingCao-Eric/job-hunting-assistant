"""Stage 2: Markdown → structured profile (CPU heuristics or gpt-4o-mini)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import defaultdict
from typing import Any

from core.trace import emit_llm_trace_event

logger = logging.getLogger(__name__)

RESUME_PARSE_MODEL = "gpt-4o-mini"
LLM_PARSE_TIMEOUT_SEC = 90.0

EMAIL_PATTERN = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
PHONE_PATTERN = re.compile(r"[\+\(]?[\d\s\(\)\-\.]{7,20}")
URL_PATTERN = re.compile(r"https?://[^\s\)\]<>]+")
LINKEDIN_GITHUB_PATTERN = re.compile(
    r"(?:https?://)?(?:www\.)?(?:linkedin\.com/[^\s\)\]<>]+|github\.com/[^\s\)\]<>]+)",
    re.I,
)
DATE_PATTERN = re.compile(
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}",
    re.I,
)
DATE_RANGE_PATTERN = re.compile(
    r"\d{4}\s*[-–—]\s*(?:\d{4}|[Pp]resent|[Cc]urrent|[Nn]ow)",
)
YEAR_ONLY_PATTERN = re.compile(r"\b(20\d{2}|19\d{2})\b")
GPA_PATTERN = re.compile(r"(?:GPA|gpa|G\.P\.A)[\s:]*(\d\.\d{1,2})")

SECTION_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    (("experience", "work", "employment", "professional"), "work_experience"),
    (("education", "academic", "qualification"), "education"),
    (("project", "portfolio"), "projects"),
    (("skill", "technical", "technology", "stack", "tools"), "skills_section"),
    (("summary", "objective", "profile", "about", "bio"), "summary"),
    (("contact", "personal", "info", "details"), "personal_section"),
]

DEGREE_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    (("ph.d", "phd", "doctorate", "d.phil"), "phd"),
    (("master", "m.sc", "msc", "m.eng", "meng", "mba", "m.a", "ms "), "master"),
    (
        (
            "bachelor",
            "b.sc",
            "bsc",
            "b.eng",
            "beng",
            "b.a",
            "ba ",
            "honours",
            "undergraduate",
            "b.tech",
        ),
        "bachelor",
    ),
    (("diploma", "certificate", "associate"), "bachelor"),
    (("no degree", "degree not required", "self-taught"), "none"),
]

LOCATION_PATTERN = re.compile(
    r"\b([A-Z][a-z]+(?:[\s\-][A-Z][a-z]+)*),\s*([A-Z]{2}|[A-Z][a-z]+(?:[\s\-][A-Z][a-z]+)*)\b"
)


def _heading_to_section(heading: str) -> str:
    h = heading.lower().strip()
    for keys, section in SECTION_KEYWORDS:
        for k in keys:
            if k in h:
                return section
    return "other"


def split_blocks(text: str) -> list[str]:
    if not text or not text.strip():
        return []
    parts = re.split(r"\n\s*\n+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def find_dates(block: str) -> list[str]:
    found: list[str] = []
    for pat in (DATE_PATTERN, DATE_RANGE_PATTERN, YEAR_ONLY_PATTERN):
        for m in pat.finditer(block):
            s = m.group(0).strip()
            if s and s not in found:
                found.append(s)
            if len(found) >= 2:
                return found[:2]
    return found


def find_degree(block: str) -> str:
    low = block.lower()
    for keys, deg in DEGREE_KEYWORDS:
        for k in keys:
            if k in low:
                return deg
    return ""


def extract_field(block: str) -> str:
    m = re.search(
        r"\b(?:in|of)\s+([A-Za-z][A-Za-z\s\-&]{2,60}?)(?:\s*[,.]|$)",
        block,
        re.I,
    )
    if m:
        return m.group(1).strip()
    return ""


def find_location(text: str) -> str:
    if re.search(r"\b[Rr]emote\b", text):
        return "Remote"
    m = LOCATION_PATTERN.search(text)
    if m:
        return f"{m.group(1)}, {m.group(2)}"
    return ""


def find_name(header_text: str) -> str:
    for line in header_text.split("\n"):
        s = line.strip()
        if not s or "@" in s or "http" in s.lower():
            continue
        if re.fullmatch(r"[\d\s\-\+\(\)]+", s):
            continue
        words = s.split()
        if 2 <= len(words) <= 5:
            if all(w[:1].isupper() or w.isupper() for w in words if w.isalpha()):
                return s
    return ""


def extract_company(block_lines: list[str]) -> str:
    for line in block_lines:
        low = line.lower()
        if " at " in low:
            parts = re.split(r"\s+at\s+", line, maxsplit=1, flags=re.I)
            if len(parts) > 1:
                return parts[1].strip()
        if " | " in line:
            parts = line.split("|", 1)
            if len(parts) > 1:
                return parts[1].strip()
    if len(block_lines) >= 2:
        second = block_lines[1].strip()
        if second and not DATE_PATTERN.search(second) and not YEAR_ONLY_PATTERN.fullmatch(
            second.strip()
        ):
            return second
    return ""


def _urls_from_text(text: str) -> list[str]:
    urls: list[str] = []
    for m in URL_PATTERN.finditer(text):
        u = m.group(0).rstrip(".,;)")
        if u not in urls:
            urls.append(u)
    for m in LINKEDIN_GITHUB_PATTERN.finditer(text):
        u = m.group(0).rstrip(".,;)")
        if u not in urls:
            urls.append(u)
    return urls


def cpu_parse_resume(markdown: str) -> dict[str, Any]:
    """Best-effort structured extraction without LLM."""
    if not markdown:
        return _empty_profile_dict()

    lines = markdown.split("\n")
    sections: dict[str, list[str]] = defaultdict(list)
    current_section = "header"

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip().lower()
            current_section = _heading_to_section(heading)
        else:
            sections[current_section].append(stripped)

    header_text = "\n".join(sections["header"] + sections.get("personal_section", []))
    email_m = EMAIL_PATTERN.search(header_text)
    phone_m = PHONE_PATTERN.search(header_text)
    personal = {
        "name": find_name(header_text),
        "email": email_m.group(0) if email_m else "",
        "phone": phone_m.group(0).strip() if phone_m else "",
        "location": find_location(header_text),
        "urls": _urls_from_text(header_text),
    }

    education: list[dict[str, Any]] = []
    edu_text = "\n".join(sections.get("education", []))
    for block in split_blocks(edu_text):
        degree_str = find_degree(block)
        dates = find_dates(block)
        block_lines = [x for x in block.split("\n") if x.strip()]
        institution = block_lines[0] if block_lines else ""
        entry = {
            "institution": institution,
            "degree": degree_str,
            "field": extract_field(block),
            "location": find_location(block),
            "start_date": dates[0] if dates else "",
            "end_date": dates[1] if len(dates) > 1 else "",
            "gpa": "",
            "remark": "",
        }
        gpa_m = GPA_PATTERN.search(block)
        if gpa_m:
            entry["gpa"] = gpa_m.group(1)
        low = block.lower()
        if any(x in low for x in ("present", "current", "now")):
            entry["end_date"] = ""
        if entry["institution"] or entry["degree"]:
            education.append(entry)

    work_experience: list[dict[str, Any]] = []
    work_text = "\n".join(sections.get("work_experience", []))
    for block in split_blocks(work_text):
        block_lines = [x.strip() for x in block.split("\n") if x.strip()]
        dates = find_dates(block)
        title = block_lines[0] if block_lines else ""
        company = extract_company(block_lines)
        desc_lines = []
        for ln in block_lines[1:]:
            if ln in dates or DATE_PATTERN.search(ln):
                continue
            desc_lines.append(ln)
        description = "\n".join(desc_lines)
        low = block.lower()
        end_date = dates[1] if len(dates) > 1 else ""
        if any(x in low for x in ("present", "current", "now")):
            end_date = ""
        entry = {
            "title": title,
            "company": company,
            "location": find_location(block),
            "start_date": dates[0] if dates else "",
            "end_date": end_date,
            "description": description,
            "skills": [],
        }
        if entry["title"] or entry["company"]:
            work_experience.append(entry)

    projects: list[dict[str, Any]] = []
    proj_text = "\n".join(sections.get("projects", []))
    for block in split_blocks(proj_text):
        lines_b = [x.strip() for x in block.split("\n") if x.strip()]
        title_line = lines_b[0] if lines_b else "Project"
        rest = "\n".join(lines_b[1:]) if len(lines_b) > 1 else block
        projects.append(
            {
                "name": title_line[:120],
                "description": rest or block,
                "date": "",
                "url": "",
                "skills": [],
            }
        )

    return {
        "personal": personal,
        "education": education,
        "work_experience": work_experience,
        "projects": projects,
        "other": [],
    }


def _empty_profile_dict() -> dict[str, Any]:
    return {
        "personal": {
            "name": "",
            "email": "",
            "phone": "",
            "location": "",
            "urls": [],
        },
        "education": [],
        "work_experience": [],
        "projects": [],
        "other": [],
    }


def _strip_json_fences(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
        raw = re.sub(r"\s*```\s*$", "", raw)
    return raw.strip()


async def llm_parse_resume(markdown: str) -> dict[str, Any]:
    from openai import AsyncOpenAI

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    system_prompt = """You are a resume parser. Extract structured data from the resume \
Markdown provided. Return only a JSON object, no explanation. \
Return null for any field not present. Do not invent information."""

    user_prompt = f"""Extract the following fields from this resume and return as JSON:

{{
  "personal": {{
    "name": string or null,
    "email": string or null,
    "phone": string or null,
    "location": string or null,
    "urls": [string] or []
  }},
  "education": [
    {{
      "degree": "bachelor" | "master" | "phd" | "none" | null,
      "field": string or null,
      "institution": string or null,
      "location": string or null,
      "start_date": "YYYY-MM" or null,
      "end_date": "YYYY-MM" or null,
      "gpa": string or null,
      "remark": null
    }}
  ],
  "work_experience": [
    {{
      "title": string or null,
      "company": string or null,
      "location": string or null,
      "start_date": "YYYY-MM" or null,
      "end_date": "YYYY-MM" or null,
      "description": string,
      "skills": [string]
    }}
  ],
  "projects": [
    {{
      "name": string or null,
      "description": string or null,
      "skills": [string] or []
    }}
  ],
  "other": []
}}

Rules:
- dates: use "YYYY-MM" format. "Present" or "Current" → null end_date
- degree: map to exactly one of: bachelor / master / phd / none / null
- skills: canonical names only; do NOT include soft skills
- description: preserve bullet points as newline-separated plain text
- Return ONLY the JSON object, no markdown fences, no explanation

Resume:
{markdown}
"""

    t0 = time.monotonic()
    outcome = "ok"
    parse_ok = True
    token_in: int | None = None
    token_out: int | None = None
    error_class: str | None = None
    error_msg: str | None = None
    last_err: Exception | None = None
    try:
        async with AsyncOpenAI(api_key=api_key) as client:
            for attempt in range(2):
                response = await client.chat.completions.create(
                    model=RESUME_PARSE_MODEL,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    response_format={"type": "json_object"},
                    max_tokens=2000,
                    temperature=0,
                )
                if hasattr(response, "usage") and response.usage:
                    token_in = getattr(response.usage, "prompt_tokens", None)
                    token_out = getattr(response.usage, "completion_tokens", None)
                raw_json = response.choices[0].message.content or ""
                try:
                    parsed = json.loads(_strip_json_fences(raw_json))
                    if not isinstance(parsed, dict):
                        raise ValueError("expected JSON object")
                    parse_ok = True
                    return normalize_parsed_resume(parsed)
                except (json.JSONDecodeError, ValueError) as e:
                    last_err = e
                    parse_ok = False
                    logger.warning("[resume/llm] JSON parse attempt %s failed: %s", attempt + 1, e)
        outcome = "fail"
        err = last_err or RuntimeError("parse failed")
        error_class = type(err).__name__
        error_msg = str(err)[:500]
        raise RuntimeError("LLM resume parse failed after 2 attempts") from last_err
    except Exception as e:
        outcome = "fail"
        parse_ok = False
        error_class = type(e).__name__
        error_msg = str(e)[:500]
        raise
    finally:
        emit_llm_trace_event(
            phase="llm_parse_resume",
            model=RESUME_PARSE_MODEL,
            t0_monotonic=t0,
            job_id=None,
            outcome=outcome,
            parse_ok=parse_ok,
            retries=0,
            token_in=token_in,
            token_out=token_out,
            error_class=error_class,
            error_msg=error_msg,
            extra={"prompt_body": {"omitted": True, "length": len(markdown)}},
        )


def normalize_parsed_resume(raw: dict[str, Any]) -> dict[str, Any]:
    """Ensure ProfileUpdate-shaped dict with string defaults and project schema."""
    p = raw.get("personal") if isinstance(raw.get("personal"), dict) else {}
    personal = {
        "name": _str_or_empty(p.get("name")),
        "email": _str_or_empty(p.get("email")),
        "phone": _str_or_empty(p.get("phone")),
        "location": _str_or_empty(p.get("location")),
        "urls": _str_list(p.get("urls")),
    }

    education: list[dict[str, Any]] = []
    for e in raw.get("education") or []:
        if not isinstance(e, dict):
            continue
        education.append(
            {
                "degree": _str_or_empty(e.get("degree")),
                "field": _str_or_empty(e.get("field")),
                "institution": _str_or_empty(e.get("institution")),
                "location": _str_or_empty(e.get("location")),
                "start_date": _str_or_empty(e.get("start_date")),
                "end_date": _str_or_empty(e.get("end_date")),
                "gpa": _str_or_empty(e.get("gpa")),
                "remark": _str_or_empty(e.get("remark")),
            }
        )

    work_experience: list[dict[str, Any]] = []
    for w in raw.get("work_experience") or []:
        if not isinstance(w, dict):
            continue
        work_experience.append(
            {
                "title": _str_or_empty(w.get("title")),
                "company": _str_or_empty(w.get("company")),
                "location": _str_or_empty(w.get("location")),
                "start_date": _str_or_empty(w.get("start_date")),
                "end_date": _str_or_empty(w.get("end_date")),
                "description": _str_or_empty(w.get("description")),
                "skills": _str_list(w.get("skills")),
            }
        )

    projects: list[dict[str, Any]] = []
    for pr in raw.get("projects") or []:
        if not isinstance(pr, dict):
            continue
        if "text" in pr and not pr.get("name"):
            text = _str_or_empty(pr.get("text"))
            lines = [x.strip() for x in text.split("\n") if x.strip()]
            projects.append(
                {
                    "name": (lines[0] if lines else "Project")[:120],
                    "description": "\n".join(lines[1:]) if len(lines) > 1 else text,
                    "date": "",
                    "url": "",
                    "skills": [],
                }
            )
        else:
            projects.append(
                {
                    "name": _str_or_empty(pr.get("name")),
                    "description": _str_or_empty(pr.get("description")),
                    "date": _str_or_empty(pr.get("date")),
                    "url": _str_or_empty(pr.get("url")),
                    "skills": _str_list(pr.get("skills")),
                }
            )

    other: list[dict[str, Any]] = []
    for o in raw.get("other") or []:
        if isinstance(o, dict):
            other.append(
                {
                    "category": _str_or_empty(o.get("category")),
                    "description": _str_or_empty(o.get("description")),
                }
            )

    return {
        "personal": personal,
        "education": education,
        "work_experience": work_experience,
        "projects": projects,
        "other": other,
    }


def _str_or_empty(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _str_list(v: Any) -> list[str]:
    if not v:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if x is not None and str(x).strip()]
    return []


async def parse_resume_markdown(markdown: str, llm_mode: bool) -> dict[str, Any]:
    """Run CPU or LLM parser; LLM timeouts fall back to CPU without raising."""
    if not llm_mode:
        return normalize_parsed_resume(cpu_parse_resume(markdown))

    try:
        return await asyncio.wait_for(
            llm_parse_resume(markdown),
            timeout=LLM_PARSE_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        logger.warning("[resume/parse] LLM timed out — using CPU parse")
        return normalize_parsed_resume(cpu_parse_resume(markdown))
    except RuntimeError as e:
        if "OPENAI_API_KEY" in str(e):
            logger.warning("[resume/parse] %s — using CPU parse", e)
            return normalize_parsed_resume(cpu_parse_resume(markdown))
        raise
