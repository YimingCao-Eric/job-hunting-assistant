"""Context-scoped debug trace buffer for dedup / matching pipelines (JHA)."""

from __future__ import annotations

import contextlib
import contextvars
import copy
import logging
import re
import time
from collections.abc import Iterator
from typing import Any

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

# Match whole-word secrets only. Previous regex matched "token_in" and
# "token_out" (OpenAI usage counts), scrubbing legitimate telemetry.
# Using word boundaries so "token" matches but "tokens_in"/"token_in" do not.
_REDACT_KEY_RE = re.compile(
    r"\b(?:token|auth|bearer|csrf|api.?key|cookie|password|secret)\b",
    re.IGNORECASE,
)
_PII_STRIP_KEYS = frozenset({"name", "email", "phone", "location", "urls", "note"})
_MAX_STR = 2000
_MAX_DEPTH = 6

_LOG_SECRET_RE = re.compile(
    r"(?i)\b(token|auth|bearer|csrf|api[\s_]?key|cookie|password|secret)\s*[=:]\s*\S+"
)


class TraceBuffer:
    def __init__(self, run_kind: str) -> None:
        self.run_kind = run_kind
        self.run_id: int | None = None
        self._run_start_ms = int(time.time() * 1000)
        self._events: list[dict[str, Any]] = []

    def append(self, event: dict[str, Any]) -> None:
        self._events.append(event)

    def events(self) -> list[dict[str, Any]]:
        return self._events

    def trim_to(self, ring_size: int) -> None:
        if len(self._events) > ring_size:
            self._events = self._events[-ring_size:]


_current_trace: contextvars.ContextVar[TraceBuffer | None] = contextvars.ContextVar(
    "_current_trace", default=None
)


def _truncate_str(s: str) -> str:
    if len(s) <= _MAX_STR:
        return s
    return s[:_MAX_STR] + "…[truncated]"


def _redact(obj: Any, depth: int = 0) -> Any:
    if depth > _MAX_DEPTH:
        return "[max_depth]"
    if isinstance(obj, str):
        return _truncate_str(obj)
    if isinstance(obj, (int, float, bool)) or obj is None:
        return obj
    if isinstance(obj, list):
        return [_redact(x, depth + 1) for x in obj]
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            ks = str(k)
            if ks.lower() in _PII_STRIP_KEYS:
                continue
            if _REDACT_KEY_RE.search(ks):
                out[ks] = "[redacted]"
            else:
                out[ks] = _redact(v, depth + 1)
        return out
    return str(obj)


class JhaTrace:
    @staticmethod
    def emit(phase: str, data: dict | None = None, level: str = "info") -> None:
        buf = _current_trace.get()
        if buf is None:
            return
        t = int(time.time() * 1000)
        dt = t - buf._run_start_ms
        payload = _redact(copy.deepcopy(data or {}))
        buf.append(
            {
                "t": t,
                "dt": dt,
                "page": None,
                "phase": phase,
                "level": level,
                "data": payload,
            }
        )


def emit_llm_trace_event(
    *,
    phase: str,
    model: str,
    t0_monotonic: float,
    job_id: str | None = None,
    outcome: str = "ok",
    parse_ok: bool = True,
    retries: int = 0,
    token_in: int | None = None,
    token_out: int | None = None,
    error_class: str | None = None,
    error_msg: str | None = None,
    extra: dict | None = None,
) -> None:
    duration_ms = int((time.monotonic() - t0_monotonic) * 1000)
    stage_map = {
        "llm_extract_done": "llm_extract",
        "llm_score_done": "llm_score",
        "llm_extract_profile_skills": "llm_extract_profile_skills",
        "llm_parse_resume": "llm_parse_resume",
    }
    data: dict[str, Any] = {
        "stage": stage_map.get(phase, phase),
        "model": model,
        "duration_ms": duration_ms,
        "outcome": outcome,
        "parse_ok": parse_ok,
        "retries": retries,
    }
    if job_id is not None:
        data["job_id"] = job_id
    if token_in is not None:
        data["token_in"] = token_in
    if token_out is not None:
        data["token_out"] = token_out
    if error_class is not None:
        data["error_class"] = error_class
    if error_msg is not None:
        data["error_msg"] = error_msg
    if extra:
        data.update(extra)
    if outcome == "fail":
        lvl = "error"
    elif outcome in {"cpu_fallback", "timeout"}:
        lvl = "warn"
    else:
        lvl = "info"
    JhaTrace.emit(phase=phase, data=data, level=lvl)


class TraceBufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        buf = _current_trace.get()
        if buf is None:
            return
        try:
            t = int(time.time() * 1000)
            dt = t - buf._run_start_ms
            msg = record.getMessage()
            msg = _LOG_SECRET_RE.sub(lambda m: m.group(1) + "=[redacted]", msg)
            msg = _truncate_str(msg)
            buf.append(
                {
                    "t": t,
                    "dt": dt,
                    "page": None,
                    "phase": "log",
                    "level": record.levelname.lower(),
                    "data": _redact(
                        {"logger": record.name, "message": msg},
                    ),
                }
            )
        except Exception:
            self.handleError(record)


# Parent loggers (dedup/matching/profile) avoid duplicate events from propagation.
# Covers D8: dedup.service, matching.*, profile.*, plus routers.matching / routers.jobs.
_BRIDGE_LOGGERS = (
    "dedup",
    "matching",
    "profile",
    "routers.matching",
    "routers.jobs",
)

_bridge_handler = TraceBufferHandler()
_bridge_handler.setLevel(logging.DEBUG)

for _ln in _BRIDGE_LOGGERS:
    logging.getLogger(_ln).addHandler(_bridge_handler)


@contextlib.contextmanager
def trace_scope(run_kind: str) -> Iterator[TraceBuffer]:
    buf = TraceBuffer(run_kind)
    token = _current_trace.set(buf)
    try:
        yield buf
    finally:
        _current_trace.reset(token)


async def flush_trace_to_report (
    db: AsyncSession,
    *,
    report_model_cls: type,
    report_id: int,
    buffer: TraceBuffer,
    ring_size: int,
) -> None:
    buffer.trim_to(ring_size)
    payload = {"events": buffer.events()}
    await db.execute(
        update(report_model_cls)
        .where(report_model_cls.id == report_id)
        .values(debug_log=payload)
    )
    await db.commit()
