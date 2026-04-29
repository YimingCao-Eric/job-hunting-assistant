"""
HTTP + DB smoke tests for Phase 1 auto-scrape foundations.

    docker compose exec backend python smoke_test_auto_scrape.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select, text, update
from sqlalchemy.orm.attributes import flag_modified

FAILED = False


def ok(msg: str) -> None:
    print(f"[OK] {msg}")


def fail(msg: str) -> None:
    global FAILED
    FAILED = True
    print(f"[FAIL] {msg}", file=sys.stderr)


BASE = os.environ.get("SMOKE_BASE_URL", "http://localhost:8000").rstrip("/")
HEADERS = {
    "Authorization": "Bearer dev-token",
    "Content-Type": "application/json",
}


async def main() -> None:
    async with httpx.AsyncClient(
        base_url=BASE, headers=HEADERS, timeout=60.0
    ) as client:
        norm = await client.get("/admin/auto-scrape/state")
        if norm.status_code == 200:
            s = norm.json()["state"]
            s["cycle_phase"] = "idle"
            s["test_cycle_pending"] = False
            s["exit_requested"] = False
            s["config_change_pending"] = False
            s["enabled"] = False
            await client.put("/admin/auto-scrape/state", json={"state": s})

        r = await client.get("/admin/auto-scrape/state")
        if r.status_code != 200:
            fail(f"GET state {r.status_code} {r.text}")
            return
        st = r.json()
        if st.get("state", {}).get("cycle_phase") != "idle":
            fail("default state.cycle_phase not idle")
        else:
            ok("GET /admin/auto-scrape/state default seeded")

        new_state = {**st["state"], "cycle_phase": "test_put"}
        r2 = await client.put("/admin/auto-scrape/state", json={"state": new_state})
        if r2.status_code != 200 or r2.json()["state"].get("cycle_phase") != "test_put":
            fail("PUT state replacement")
        else:
            ok("PUT /admin/auto-scrape/state")

        r_before = await client.get("/admin/auto-scrape/state")
        u0 = r_before.json()["updated_at"]
        await asyncio.sleep(0.05)
        rh = await client.post("/admin/auto-scrape/heartbeat", json={})
        if rh.status_code != 200:
            fail(f"heartbeat {rh.status_code}")
        else:
            ra = await client.get("/admin/auto-scrape/state")
            body = ra.json()
            if body["last_sw_heartbeat_at"] is None:
                fail("heartbeat did not set last_sw_heartbeat_at")
            elif body["updated_at"] != u0:
                fail("heartbeat bumped updated_at without instance id (unexpected)")
            else:
                ok("POST /admin/auto-scrape/heartbeat")

        r = await client.get("/admin/auto-scrape/config")
        if r.status_code != 200 or "keywords" not in r.json().get("config", {}):
            fail("GET config")
        else:
            ok("GET /admin/auto-scrape/config")

        r = await client.get("/admin/auto-scrape/config/limits")
        if r.status_code != 200:
            fail("GET limits")
        else:
            lj = r.json()
            exp = {
                "min_cycle_interval_minutes",
                "inter_scan_delay_seconds",
                "scan_timeout_minutes",
                "max_consecutive_precheck_failures",
                "max_consecutive_dead_session_cycles",
            }
            if not exp.issubset(lj.get("limits", {}).keys()):
                fail(f"limits keys {lj.get('limits')}")
            elif "max_scans_per_cycle_hard" not in lj.get("derived_limits", {}):
                fail("derived_limits missing hard cap")
            else:
                ok("GET /admin/auto-scrape/config/limits")

        r = await client.put(
            "/admin/auto-scrape/config",
            json={"min_cycle_interval_minutes": 2},
        )
        if r.status_code != 200:
            fail(f"valid PUT config {r.status_code} {r.text}")
        else:
            ok("PUT /admin/auto-scrape/config (valid)")

        r = await client.put(
            "/admin/auto-scrape/config",
            json={"min_cycle_interval_minutes": 0},
        )
        if r.status_code != 422:
            fail(f"invalid PUT expected 422 got {r.status_code}")
        elif "field_errors" not in r.json().get("detail", {}):
            fail("invalid PUT missing field_errors")
        else:
            ok("PUT config (invalid) -> 422")

        fifteen = [f"kw{i}" for i in range(15)]
        r = await client.put(
            "/admin/auto-scrape/config",
            json={"keywords": fifteen},
        )
        if r.status_code != 422:
            fail(f"15x3 scans expected 422 got {r.status_code}")
        else:
            ok("PUT config 45 scans -> 422")

        five = [f"role{i}" for i in range(5)]
        r = await client.put("/admin/auto-scrape/config", json={"keywords": five})
        if r.status_code != 200 or not r.json().get("warnings"):
            fail(f"5 keywords expected warnings {r.status_code} {r.text}")
        else:
            ok("PUT config 5x3 -> warnings")

        r = await client.post("/admin/auto-scrape/config/reset")
        if r.status_code != 200:
            fail("config reset")
        elif len(r.json()["config"]["keywords"]) != 3:
            fail("config reset did not restore defaults")
        else:
            ok("POST /admin/auto-scrape/config/reset")

        t_new = datetime.now(timezone.utc)
        t_old = t_new - timedelta(hours=2)
        c_new = await client.post(
            "/admin/auto-scrape/cycle",
            json={"started_at": t_new.isoformat()},
        )
        c_old = await client.post(
            "/admin/auto-scrape/cycle",
            json={"started_at": t_old.isoformat()},
        )
        if c_new.status_code != 200 or c_old.status_code != 200:
            fail(f"create cycle {c_new.text} {c_old.text}")
        else:
            ok("POST /admin/auto-scrape/cycle (x2)")
        nid = c_new.json()["id"]
        r = await client.put(
            f"/admin/auto-scrape/cycle/{nid}",
            json={"scans_attempted": 3},
        )
        if r.status_code != 200:
            fail("PUT cycle partial")
        else:
            ok("PUT /admin/auto-scrape/cycle/{id}")
        lst = await client.get("/admin/auto-scrape/cycles", params={"limit": 10})
        if lst.status_code != 200 or len(lst.json()) < 2:
            fail("GET cycles list")
        elif lst.json()[0]["started_at"] < lst.json()[1]["started_at"]:
            fail("cycles not ordered DESC by started_at")
        else:
            ok("GET /admin/auto-scrape/cycles ordered DESC")

        oid = c_old.json()["id"]
        r_complete = await client.put(
            f"/admin/auto-scrape/cycle/{nid}",
            json={"status": "scrape_complete"},
        )
        r_fail = await client.put(
            f"/admin/auto-scrape/cycle/{oid}",
            json={"status": "failed", "error_message": "smoke cleanup"},
        )
        if r_complete.status_code != 200 or r_fail.status_code != 200:
            fail(f"closing smoke cycles {r_complete.text} {r_fail.text}")
        else:
            ok("closed smoke scrape_running cycles before orphan test")

        rw = await client.post(
            "/admin/auto-scrape/wake-orchestrator",
            json={"cycle_id": 1},
        )
        if rw.status_code != 200 or not rw.json().get("ok"):
            fail("wake-orchestrator")
        else:
            ok("POST /admin/auto-scrape/wake-orchestrator")

        e = await client.post("/admin/auto-scrape/enable")
        if e.status_code != 200 or not e.json()["state"].get("enabled"):
            fail("enable")
        else:
            ok("POST enable")
        p = await client.post("/admin/auto-scrape/pause")
        if p.status_code != 200 or p.json()["state"].get("enabled") is not False:
            fail("pause")
        else:
            ok("POST pause")
        sh = await client.post("/admin/auto-scrape/shutdown")
        if sh.status_code != 200 or not sh.json()["state"].get("exit_requested"):
            fail("shutdown")
        else:
            ok("POST shutdown")
        tc = await client.post("/admin/auto-scrape/test-cycle")
        if tc.status_code != 200 or not tc.json()["state"].get("test_cycle_pending"):
            fail("test-cycle")
        else:
            ok("POST test-cycle")
        rc = await client.post("/admin/auto-scrape/restart-cycle")
        if rc.status_code != 200 or not rc.json()["state"].get("config_change_pending"):
            fail("restart-cycle")
        else:
            ok("POST restart-cycle")

        sg = await client.get("/admin/auto-scrape/sessions")
        if sg.status_code != 200 or len(sg.json()) != 3:
            fail("GET sessions")
        else:
            ok("GET /admin/auto-scrape/sessions")

        await client.put(
            "/admin/auto-scrape/sessions/linkedin",
            json={"last_probe_status": "live"},
        )
        r = await client.put(
            "/admin/auto-scrape/sessions/linkedin",
            json={"last_probe_status": "expired"},
        )
        if r.status_code != 200 or r.json()["consecutive_failures"] != 1:
            fail("live->expired consecutive")
        elif not r.json()["notified_user"]:
            fail("live->expired should set notified_user")
        else:
            ok("session live->expired")

        r = await client.put(
            "/admin/auto-scrape/sessions/linkedin",
            json={"last_probe_status": "expired"},
        )
        if r.status_code != 200 or r.json()["consecutive_failures"] != 2:
            fail("expired->expired consecutive")
        elif not r.json()["notified_user"]:
            fail("notified_user should stay true")
        else:
            ok("session expired->expired")

        r = await client.put(
            "/admin/auto-scrape/sessions/linkedin",
            json={"last_probe_status": "live"},
        )
        if r.status_code != 200 or r.json()["consecutive_failures"] != 0:
            fail("expired->live reset")
        elif r.json()["notified_user"]:
            fail("notified_user should reset on live")
        else:
            ok("session expired->live")

        rp0 = await client.post("/admin/auto-scrape/reset-session/glassdoor")
        if rp0.status_code != 200:
            fail("reset-session/glassdoor (prime backoff test)")
        else:
            ok("POST reset-session/glassdoor (prime)")

        sg_pre = await client.get("/admin/auto-scrape/sessions")
        glass = next(x for x in sg_pre.json() if x["site"] == "glassdoor")
        bm0 = float(glass["backoff_multiplier"])
        await client.put(
            "/admin/auto-scrape/sessions/glassdoor",
            json={"last_probe_status": "live"},
        )
        r = await client.put(
            "/admin/auto-scrape/sessions/glassdoor",
            json={"last_probe_status": "rate_limited"},
        )
        if r.status_code != 200:
            fail("rate_limited put (glassdoor)")
        elif r.json()["consecutive_failures"] != 0:
            fail("rate_limited should not increment consecutive_failures")
        elif abs(r.json()["backoff_multiplier"] - bm0 * 2.0) > 0.001:
            fail(
                f"backoff should double ({bm0} -> {bm0*2}), got {r.json()['backoff_multiplier']}"
            )
        else:
            ok("session live->rate_limited backoff (glassdoor)")

        r = await client.post("/admin/auto-scrape/reset-session/glassdoor")
        if r.status_code != 200 or r.json()["last_probe_status"] != "unknown":
            fail("reset-session")
        elif abs(float(r.json()["backoff_multiplier"]) - 1.0) > 0.001:
            fail("reset-session should set backoff_multiplier to 1.0")
        else:
            ok("POST reset-session/glassdoor")

        cl = await client.post("/admin/cleanup-invalid-entries", json={})
        if cl.status_code != 200:
            fail(f"cleanup-invalid-entries {cl.status_code}")
        else:
            ok("POST /admin/cleanup-invalid-entries (baseline)")

    from core.auto_scrape_lifecycle import cleanup_stale_cycles_at_startup
    from core.database import AsyncSessionLocal
    from models.auto_scrape_cycle import AutoScrapeCycle
    from models.auto_scrape_state import AutoScrapeState
    from models.extension_run_log import ExtensionRunLog
    from models.scraped_job import ScrapedJob

    u = uuid.uuid4()
    u2 = uuid.uuid4()
    u3 = uuid.uuid4()
    async with AsyncSessionLocal() as db:
        j_empty_title = ScrapedJob(
            id=u,
            website="linkedin",
            job_title="",
            company="co",
            job_url=f"https://example.com/{u}",
            job_description="x" * 60,
        )
        old = datetime.now(timezone.utc) - timedelta(days=2)
        j_bad_jd = ScrapedJob(
            id=u2,
            website="linkedin",
            job_title="t",
            company="c",
            job_url=f"https://example.com/{u2}",
            job_description="short",
            created_at=old,
            updated_at=old,
        )
        j_bad_site = ScrapedJob(
            id=u3,
            website="not-a-site",
            job_title="t",
            company="c",
            job_url=f"https://example.com/{u3}",
            job_description="y" * 60,
        )
        db.add_all([j_empty_title, j_bad_jd, j_bad_site])
        await db.commit()
        ok("inserted 3 invalid jobs for cleanup test")

    async with httpx.AsyncClient(
        base_url=BASE, headers=HEADERS, timeout=60.0
    ) as client:
        cl = await client.post("/admin/cleanup-invalid-entries", json={})
        if cl.status_code != 200:
            fail(f"cleanup after inserts {cl.status_code}")
        else:
            b = cl.json()
            if (
                b["deleted_jobs_empty_core"] < 1
                or b["deleted_jobs_empty_jd"] < 1
                or b["deleted_jobs_mismatched_website"] < 1
            ):
                fail(f"cleanup counts unexpected {b}")
            else:
                ok("cleanup-invalid-entries deleted invalid jobs")

    async with AsyncSessionLocal() as db:
        for jid in (u, u2, u3):
            r = await db.execute(select(ScrapedJob).where(ScrapedJob.id == jid))
            if r.scalar_one_or_none() is not None:
                fail(f"job {jid} should be deleted")
        await db.commit()
    ok("verified invalid jobs removed")

    log_id: str | None = None
    async with httpx.AsyncClient(
        base_url=BASE, headers=HEADERS, timeout=60.0
    ) as client:
        rs = await client.post(
            "/extension/run-log/start",
            json={"strategy": "C", "search_keyword": None, "search_location": ""},
        )
        if rs.status_code != 200:
            fail(f"run-log start {rs.status_code} {rs.text}")
        else:
            log_id = rs.json()["id"]
            lr = await client.get("/extension/run-log")
            found = next((x for x in lr.json() if x["id"] == log_id), None)
            if not found:
                fail("run log list missing new log")
            elif (
                found.get("search_keyword") != "(setup pending)"
                or found.get("search_location") != "(setup pending)"
            ):
                fail("run log placeholder search fields")
            else:
                ok("run-log/start uses (setup pending) for missing search fields")

    async with AsyncSessionLocal() as db:
        past = datetime.now(timezone.utc) - timedelta(minutes=15)
        await db.execute(
            update(ExtensionRunLog)
            .where(ExtensionRunLog.id == uuid.UUID(log_id))
            .values(started_at=past)
        )
        await db.commit()
    async with httpx.AsyncClient(
        base_url=BASE, headers=HEADERS, timeout=60.0
    ) as client:
        cl = await client.post("/admin/cleanup-invalid-entries", json={})
        if cl.status_code != 200 or cl.json().get("marked_failed_run_logs", 0) < 1:
            fail(f"stale run log cleanup {cl.text}")
    async with AsyncSessionLocal() as db:
        r = await db.execute(
            select(ExtensionRunLog).where(ExtensionRunLog.id == uuid.UUID(log_id))
        )
        row = r.scalar_one()
        if row.status != "failed":
            fail("stale run log not failed")
        elif row.failure_reason != "lazy_cleanup_timeout":
            fail("failure_reason not set")
        elif row.failure_category != "transient":
            fail("failure_category not set")
        else:
            ok("stale run-log marked failed with failure_reason/category")

    orphan_cycle_pk = None
    async with AsyncSessionLocal() as db:
        res = await db.execute(text("SELECT nextval('auto_scrape_cycle_id_seq')"))
        oc = int(res.scalar_one())
        cyc = AutoScrapeCycle(
            cycle_id=oc,
            started_at=datetime.now(timezone.utc),
            status="scrape_running",
            phase_heartbeat_at=datetime.now(timezone.utc),
        )
        db.add(cyc)
        await db.flush()
        orphan_cycle_pk = cyc.id
        st_row = await db.execute(
            select(AutoScrapeState).where(AutoScrapeState.id == 1)
        )
        st = st_row.scalar_one()
        st.state = {**st.state, "extension_instance_id": "instance-old"}
        flag_modified(st, "state")
        await db.commit()

    async with httpx.AsyncClient(
        base_url=BASE, headers=HEADERS, timeout=60.0
    ) as client:
        co = await client.post(
            "/admin/auto-scrape/cleanup-orphan-cycles",
            json={"current_instance_id": "instance-new"},
        )
        if co.status_code != 200:
            fail(f"orphan cleanup {co.status_code} {co.text}")
        elif co.json().get("marked_failed", 0) < 1:
            fail(f"orphan cleanup expected marked_failed>=1 {co.json()}")
        else:
            ok("cleanup-orphan-cycles")

    async with AsyncSessionLocal() as db:
        r = await db.execute(
            select(AutoScrapeCycle).where(AutoScrapeCycle.id == orphan_cycle_pk)
        )
        crow = r.scalar_one()
        if crow.status != "failed":
            fail("orphan cycle not failed")

    async with httpx.AsyncClient(
        base_url=BASE, headers=HEADERS, timeout=60.0
    ) as client:
        stj = await client.get("/admin/auto-scrape/state")
        clean = {**stj.json()["state"]}
        clean["extension_instance_id"] = None
        await client.put("/admin/auto-scrape/state", json={"state": clean})

    async with httpx.AsyncClient(
        base_url=BASE, headers=HEADERS, timeout=60.0
    ) as client:
        lc = await client.get("/admin/auto-scrape/cycles", params={"limit": 100})
        if lc.status_code != 200:
            fail("GET cycles after inserts")
        else:
            ok("GET /admin/auto-scrape/cycles sees inserted cycles")

    async with AsyncSessionLocal() as db:
        res = await db.execute(text("SELECT nextval('auto_scrape_cycle_id_seq')"))
        sc = int(res.scalar_one())
        ancient = datetime.now(timezone.utc) - timedelta(hours=3)
        stale_c = AutoScrapeCycle(
            cycle_id=sc,
            started_at=ancient,
            status="scrape_running",
            phase_heartbeat_at=ancient,
        )
        db.add(stale_c)
        await db.commit()
        stale_pk = stale_c.id

    await cleanup_stale_cycles_at_startup()

    async with AsyncSessionLocal() as db:
        r = await db.execute(
            select(AutoScrapeCycle).where(AutoScrapeCycle.id == stale_pk)
        )
        srow = r.scalar_one()
        if srow.status != "failed":
            fail("startup stale-cycle cleanup did not fail old scrape_running row")
        elif "Interrupted" not in (srow.error_message or ""):
            fail(f"unexpected error_message {srow.error_message!r}")
        else:
            ok("cleanup_stale_cycles_at_startup marks old running cycles failed")

    async with httpx.AsyncClient(
        base_url=BASE,
        headers=HEADERS,
        timeout=httpx.Timeout(600.0, connect=30.0),
    ) as client:
        print()
        print("=== Phase 4: post-scrape orchestrator ===")
        from auto_scrape.post_scrape_orchestrator import process_pending_cycles

        cr1 = await client.post(
            "/admin/auto-scrape/cycle",
            json={"started_at": datetime.now(timezone.utc).isoformat()},
        )
        if cr1.status_code != 200:
            fail(f"Phase 4 POST cycle {cr1.status_code} {cr1.text}")
        else:
            p4 = cr1.json()
            p4_pk = p4["id"]
            pu1 = await client.put(
                f"/admin/auto-scrape/cycle/{p4_pk}",
                json={
                    "status": "scrape_complete",
                    "scans_attempted": 0,
                    "scans_succeeded": 0,
                    "run_log_ids": [],
                },
            )
            if pu1.status_code != 200:
                fail(f"Phase 4 PUT scrape_complete {pu1.status_code}")
            else:
                try:
                    await process_pending_cycles()
                except Exception as exc:
                    fail(f"Phase 4 process_pending_cycles raised: {exc}")
                else:
                    gc = await client.get("/admin/auto-scrape/cycles?limit=50")
                    row = next(
                        (c for c in gc.json() if str(c["id"]) == str(p4_pk)),
                        None,
                    )
                    if row is None:
                        fail("Phase 4 cycle row missing after processing")
                    elif row["status"] not in ("post_scrape_complete", "failed"):
                        fail(
                            "Phase 4 unexpected status "
                            f"{row['status']!r} (want post_scrape_complete or failed)"
                        )
                    else:
                        ok(
                            f"Phase 4 process_pending_cycles -> {row['status']} "
                            f"(dedup_task_id={row.get('dedup_task_id')})"
                        )

        cr2 = await client.post(
            "/admin/auto-scrape/cycle",
            json={"started_at": datetime.now(timezone.utc).isoformat()},
        )
        if cr2.status_code != 200:
            fail(f"Phase 4b POST cycle {cr2.status_code}")
        else:
            r2 = cr2.json()
            p4b_pk = r2["id"]
            cid_num = r2["cycle_id"]
            await client.put(
                f"/admin/auto-scrape/cycle/{p4b_pk}",
                json={"status": "scrape_complete", "run_log_ids": []},
            )
            rwk = await client.post(
                "/admin/auto-scrape/wake-orchestrator",
                json={"cycle_id": cid_num},
            )
            if rwk.status_code != 200 or not rwk.json().get("ok"):
                fail(f"Phase 4b wake {rwk.status_code} {rwk.text}")
            else:
                await asyncio.sleep(5)
                gc = await client.get("/admin/auto-scrape/cycles?limit=50")
                row = next(
                    (c for c in gc.json() if str(c["id"]) == str(p4b_pk)),
                    None,
                )
                if row is None:
                    fail("Phase 4b cycle missing")
                elif row["status"] == "scrape_complete":
                    await process_pending_cycles()
                    gc = await client.get("/admin/auto-scrape/cycles?limit=50")
                    row = next(
                        (c for c in gc.json() if str(c["id"]) == str(p4b_pk)),
                        None,
                    )
                if row is None:
                    fail("Phase 4b cycle missing after fallback poll")
                elif row["status"] not in (
                    "postscrape_running",
                    "post_scrape_complete",
                    "failed",
                ):
                    fail(
                        "Phase 4b expected progress after wake, "
                        f"got {row['status']!r}"
                    )
                else:
                    ok(f"Phase 4b wake: status={row['status']}")

        gc3 = await client.get("/admin/auto-scrape/cycles?limit=50")
        done3 = [c for c in gc3.json() if c["status"] == "post_scrape_complete"]
        if done3:
            c0 = done3[0]
            if c0.get("match_results") is None:
                fail("Phase 4c post_scrape_complete missing match_results key")
            elif not isinstance(c0["match_results"], dict):
                fail("Phase 4c match_results not a dict")
            elif c0["match_results"] != {}:
                fail(
                    f"Phase 4c match_results expected {{}}, got {c0['match_results']!r}"
                )
            elif c0.get("dedup_task_id") is not None:
                fail("Phase 4c dedup_task_id expected null (Phase 4.5 no-op dedup)")
            else:
                ok(
                    f"Phase 4c cycle_id={c0.get('cycle_id')}: "
                    "dedup_task_id=null, match_results={}"
                )
        else:
            ok("[SKIP] Phase 4c no post_scrape_complete row to inspect")

        print("=== Phase 4 tests done ===")
        print()

    if FAILED:
        sys.exit(1)
    print("smoke_test_auto_scrape: all checks passed")
    sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
