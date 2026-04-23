from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from core.auth import get_current_user
from core.config_file import read_config_file
from core.profile_file import get_empty_profile, read_profile, write_profile
from matching.normaliser import normalise
from profile.pdf_extractor import extract_resume_markdown
from profile.resume_parser import llm_parse_resume
from profile.service import extract_profile
from schemas.profile import ProfileData, ProfileExtracted, ProfileUpdate, ResumeParseRequest

router = APIRouter(prefix="/profile", tags=["profile"])


def _profile_response(p: ProfileData) -> JSONResponse:
    return JSONResponse(content=p.model_dump(mode="json", by_alias=True))


def _merge_raw_profile(raw: dict) -> dict:
    empty = get_empty_profile()
    if not isinstance(raw, dict):
        return empty
    merged = deep_merge(empty, raw)
    return merged


def deep_merge(base: dict, overlay: dict) -> dict:
    out = dict(base)
    for k, v in overlay.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _normalise_extra_skills_for_save(raw: list[str] | None) -> list[str]:
    """Split CSV tokens, map aliases to canonical names; dedupe preserving order."""
    tokens: list[str] = []
    for raw_skill in raw or []:
        s = str(raw_skill).strip()
        if not s:
            continue
        if "," in s:
            for part in s.split(","):
                t = part.strip()
                if t:
                    tokens.append(t)
        else:
            tokens.append(s)
    normalised: list[str] = []
    seen: set[str] = set()
    for raw_skill in tokens:
        canonical = normalise(raw_skill)
        if not canonical:
            continue
        k = canonical.lower()
        if k not in seen:
            seen.add(k)
            normalised.append(canonical)
    return normalised


@router.get("")
async def get_profile(_user: dict = Depends(get_current_user)):
    raw = read_profile()
    merged = _merge_raw_profile(raw)
    return _profile_response(ProfileData.model_validate(merged))


@router.put("")
async def put_profile(
    body: ProfileUpdate,
    _user: dict = Depends(get_current_user),
):
    if not body.education:
        raise HTTPException(
            status_code=422,
            detail="At least one education entry is required.",
        )
    cfg = await read_config_file()
    llm = bool(cfg.get("llm", False))

    payload = body.model_dump()
    merged = _merge_raw_profile(
        {
            "personal": payload["personal"],
            "education": payload["education"],
            "work_experience": payload["work_experience"],
            "projects": payload["projects"],
            "other": payload["other"],
            "extra_skills": _normalise_extra_skills_for_save(payload.get("extra_skills")),
        }
    )
    updated = await extract_profile(merged, llm=llm)
    write_profile(updated)
    return _profile_response(ProfileData.model_validate(updated))


@router.get("/extracted", response_model=ProfileExtracted)
async def get_profile_extracted(_user: dict = Depends(get_current_user)):
    raw = read_profile()
    merged = _merge_raw_profile(raw)
    ext = merged.get("_extracted") or {}
    if not isinstance(ext, dict):
        ext = {}
    return ProfileExtracted.model_validate(ext)


MAX_RESUME_BYTES = 10 * 1024 * 1024


@router.post("/upload-resume")
async def upload_resume(
    file: UploadFile = File(...),
    _user: dict = Depends(get_current_user),
):
    """Stage 1: PDF → Markdown (opendataloader-pdf)."""
    name = file.filename or "resume.pdf"
    if not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    pdf_bytes = await file.read()
    if len(pdf_bytes) > MAX_RESUME_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 10MB)")

    try:
        markdown_text = extract_resume_markdown(pdf_bytes, name)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"PDF extraction failed: {e!s}",
        ) from e

    return {
        "markdown": markdown_text,
        "char_count": len(markdown_text),
        "filename": name,
    }


@router.post("/parse-resume")
async def parse_resume(
    body: ResumeParseRequest,
    _user: dict = Depends(get_current_user),
):
    """Stage 2: Markdown → structured profile fields (always LLM — CPU heuristics are too fragile)."""
    try:
        result = await llm_parse_resume(body.markdown)
    except RuntimeError as e:
        msg = str(e)
        if "LLM resume parse failed" in msg:
            raise HTTPException(
                status_code=500,
                detail="Could not parse resume — please enter fields manually",
            ) from e
        raise HTTPException(status_code=500, detail=msg) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return result
