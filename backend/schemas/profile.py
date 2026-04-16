from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class PersonalInfo(BaseModel):
    name: str
    email: str
    phone: Optional[str] = None
    location: str
    urls: List[str] = Field(default_factory=list)


class EducationEntry(BaseModel):
    degree: str
    field: str
    institution: str
    location: str
    start_date: str
    end_date: Optional[str] = None
    gpa: Optional[str] = None
    remark: Optional[str] = None


class WorkExperienceEntry(BaseModel):
    title: str
    company: str
    location: str
    start_date: str
    end_date: Optional[str] = None
    description: str
    skills: List[str] = Field(default_factory=list)


class ProjectEntry(BaseModel):
    name: str
    description: str
    date: str
    url: Optional[str] = None
    skills: List[str] = Field(default_factory=list)


class OtherEntry(BaseModel):
    category: str
    description: Optional[str] = None


class ExtractedData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    yoe: Optional[float] = None
    skills: List[str] = Field(default_factory=list)
    extraction_mode: Optional[str] = None
    extracted_at: Optional[str] = None


class ProfileData(BaseModel):
    """Full profile — used for GET /profile response."""

    model_config = ConfigDict(populate_by_name=True)

    personal: PersonalInfo
    education: List[EducationEntry] = Field(default_factory=list)
    work_experience: List[WorkExperienceEntry] = Field(default_factory=list)
    projects: List[ProjectEntry] = Field(default_factory=list)
    other: List[OtherEntry] = Field(default_factory=list)
    extra_skills: List[str] = Field(default_factory=list)
    extracted: ExtractedData = Field(
        default_factory=ExtractedData,
        validation_alias="_extracted",
        serialization_alias="_extracted",
    )


class ProfileUpdate(BaseModel):
    """Request body for PUT /profile — user-editable fields only."""

    personal: PersonalInfo
    education: List[EducationEntry] = Field(default_factory=list)
    work_experience: List[WorkExperienceEntry] = Field(default_factory=list)
    projects: List[ProjectEntry] = Field(default_factory=list)
    other: List[OtherEntry] = Field(default_factory=list)
    extra_skills: List[str] = Field(default_factory=list)


class ProfileExtracted(BaseModel):
    """Response for GET /profile/extracted."""

    yoe: Optional[float] = None
    skills: List[str] = Field(default_factory=list)
    extraction_mode: Optional[str] = None
    extracted_at: Optional[str] = None


class ResumeParseRequest(BaseModel):
    """Body for POST /profile/parse-resume."""

    markdown: str
