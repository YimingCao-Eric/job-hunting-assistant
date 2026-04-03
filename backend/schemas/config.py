from typing import Optional

from pydantic import BaseModel


class SearchConfigRead(BaseModel):
    website: str = "linkedin"
    indeed_keyword: str | None = None
    indeed_location: str | None = None
    indeed_fromage: int = 1
    indeed_remotejob: bool | None = None
    indeed_jt: str | None = None
    indeed_sort: str = "relevance"
    indeed_radius: int | None = None
    indeed_explvl: str | None = None
    indeed_lang: str | None = None
    general_date_posted: int = 1
    general_internship_only: bool = False
    general_remote_only: bool = False
    keyword: str
    location: str = "Canada"
    f_tpr_bound: int = 48
    f_experience: str | None = None
    f_job_type: str | None = None
    f_remote: str | None = None
    salary_min: int = 0
    linkedin_f_tpr: str | None = None
    glassdoor: dict | None = None
    dedup_mode: str = "manual"
    blacklist_companies: list[str] = []
    blacklist_locations: list[str] = []
    blacklist_titles: list[str] = []
    target_titles: list[str] = []
    allowed_languages: list[str] = ["en"]
    no_contract: bool = False
    remote_only: bool = False
    needs_sponsorship: bool = False
    no_agency: bool = False
    dedup_fuzzy_threshold: int = 85


class SearchConfigUpdate(BaseModel):
    website: str | None = None
    indeed_keyword: str | None = None
    indeed_location: str | None = None
    indeed_fromage: int | None = None
    indeed_remotejob: bool | None = None
    indeed_jt: str | None = None
    indeed_sort: str | None = None
    indeed_radius: int | None = None
    indeed_explvl: str | None = None
    indeed_lang: str | None = None
    general_date_posted: int | None = None
    general_internship_only: bool | None = None
    general_remote_only: bool | None = None
    keyword: str | None = None
    location: str | None = None
    f_tpr_bound: int | None = None
    f_experience: str | None = None
    f_job_type: str | None = None
    f_remote: str | None = None
    salary_min: int | None = None
    linkedin_f_tpr: str | None = None
    glassdoor: dict | None = None
    dedup_mode: Optional[str] = None
    blacklist_companies: Optional[list[str]] = None
    blacklist_locations: Optional[list[str]] = None
    blacklist_titles: Optional[list[str]] = None
    target_titles: Optional[list[str]] = None
    allowed_languages: Optional[list[str]] = None
    no_contract: Optional[bool] = None
    remote_only: Optional[bool] = None
    needs_sponsorship: Optional[bool] = None
    no_agency: Optional[bool] = None
    dedup_fuzzy_threshold: Optional[int] = None
