"""WebSocket fan-out for run-log row updates (B-14 layer C)."""

import json
from typing import Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from models.extension_run_log import ExtensionRunLog
from schemas.run_log import RunLogRead

router = APIRouter(tags=["extension"])

_run_log_subscribers: Set[WebSocket] = set()

DEV_WS_TOKEN = "dev-token"


@router.websocket("/ws/run-log")
async def ws_run_log(websocket: WebSocket):
    subprotocols = websocket.scope.get("subprotocols") or []
    token = None
    if len(subprotocols) >= 2 and subprotocols[0] == "bearer":
        token = subprotocols[1]
    if token != DEV_WS_TOKEN:
        await websocket.close(code=1008)
        return
    await websocket.accept(subprotocol="bearer")
    _run_log_subscribers.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        _run_log_subscribers.discard(websocket)
    except Exception:
        _run_log_subscribers.discard(websocket)
        raise


async def broadcast_run_log_update(log: ExtensionRunLog) -> None:
    if not _run_log_subscribers:
        return
    r = RunLogRead.model_validate(log)
    payload = r.model_dump(mode="json", exclude={"debug_log"})
    msg = json.dumps(payload, default=str)
    dead = []
    for ws in list(_run_log_subscribers):
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _run_log_subscribers.discard(ws)
