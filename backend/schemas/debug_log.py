from pydantic import BaseModel, ConfigDict, Field


class DebugEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    t: int
    dt: int
    page: int | None = None
    phase: str
    level: str = "info"
    data: dict = Field(default_factory=dict)


class DebugLogAppend(BaseModel):
    events: list[DebugEvent]
