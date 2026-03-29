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
    indeed_enabled: bool = False
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
    scan_delay: str = "normal"
    linkedin_f_tpr: str | None = None
    glassdoor: dict | None = None


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
    indeed_enabled: bool | None = None
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
    scan_delay: str | None = None
    linkedin_f_tpr: str | None = None
    glassdoor: dict | None = None
