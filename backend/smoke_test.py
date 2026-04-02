"""Smoke tests for the Job Hunting Assistant API.

Run with:
    python smoke_test.py                          # from backend dir, server on localhost:8000
    docker compose exec backend python smoke_test.py  # inside Docker
"""

import asyncio
import sys

import httpx

BASE = "http://localhost:8000"
HEADERS = {"Authorization": "Bearer dev-token", "Content-Type": "application/json"}


async def main() -> None:
    async with httpx.AsyncClient(base_url=BASE, headers=HEADERS, timeout=10) as c:
        # ── a. Health ─────────────────────────────────────────────────
        r = await c.get("/health")
        assert r.status_code == 200, f"GET /health → {r.status_code}"
        body = r.json()
        assert body["status"] == "ok", f"health status: {body}"
        print(f"  [OK] GET /health → {body}")

        # ── b. Config ────────────────────────────────────────────────
        r = await c.get("/config")
        assert r.status_code == 200, f"GET /config → {r.status_code}"
        config = r.json()
        print(f"  [OK] GET /config → {config}")

        # ── c. Ingest a sample job ───────────────────────────────────
        sample_job = {
            "website": "linkedin",
            "job_title": "Senior Backend Engineer",
            "company": "Acme Corp",
            "location": "Toronto, ON",
            "job_description": "Build scalable microservices with Python and PostgreSQL. "
            "Requires 5+ years of experience.",
            "job_url": "https://www.linkedin.com/jobs/view/smoke-test-001",
            "easy_apply": True,
        }
        r = await c.post("/jobs/ingest", json=sample_job)
        assert r.status_code == 200, f"POST /jobs/ingest → {r.status_code}: {r.text}"
        ingest = r.json()
        assert "id" in ingest, f"ingest missing id: {ingest}"
        job_id = ingest["id"]
        print(f"  [OK] POST /jobs/ingest → id={job_id}, "
              f"already_exists={ingest['already_exists']}, "
              f"content_duplicate={ingest['content_duplicate']}")

        # ── c2. Ingest Indeed job (for website filter) ───────────────
        indeed_job = {
            "website": "indeed",
            "job_title": "Platform Engineer",
            "company": "Beta Inc",
            "location": "Vancouver, BC",
            "job_description": "Indeed smoke description unique string xyzabc123.",
            "job_url": "https://ca.indeed.com/viewjob?jk=smoke-indeed-002",
            "easy_apply": False,
        }
        r = await c.post("/jobs/ingest", json=indeed_job)
        assert r.status_code == 200, f"POST /jobs/ingest indeed → {r.status_code}: {r.text}"
        indeed_ingest = r.json()
        indeed_job_id = indeed_ingest["id"]
        print(f"  [OK] POST /jobs/ingest (indeed) → id={indeed_job_id}")

        # ── d. List jobs ─────────────────────────────────────────────
        r = await c.get("/jobs", params={"limit": 5})
        assert r.status_code == 200, f"GET /jobs → {r.status_code}"
        payload = r.json()
        jobs = payload["items"]
        ids = [j["id"] for j in jobs]
        assert job_id in ids, f"ingested job {job_id} not in job list"
        assert payload.get("total", 0) >= len(jobs)
        print(f"  [OK] GET /jobs → {len(jobs)} job(s), ingested job present")

        # ── d2. GET /jobs?website= filter ───────────────────────────
        r = await c.get("/jobs", params={"website": "linkedin", "limit": 100})
        assert r.status_code == 200, f"GET /jobs?website=linkedin → {r.status_code}"
        lj = r.json()["items"]
        assert all(j["website"] == "linkedin" for j in lj), lj
        assert job_id in [x["id"] for x in lj]
        print(f"  [OK] GET /jobs?website=linkedin → {len(lj)} row(s), all linkedin")

        r = await c.get("/jobs", params={"website": "indeed", "limit": 100})
        assert r.status_code == 200, f"GET /jobs?website=indeed → {r.status_code}"
        ij = r.json()["items"]
        assert all(j["website"] == "indeed" for j in ij), ij
        assert indeed_job_id in [x["id"] for x in ij]
        print(f"  [OK] GET /jobs?website=indeed → {len(ij)} row(s), all indeed")

        # ── c3. Content duplicate → original_job_id on new row ────────
        dup_job = {
            "website": "linkedin",
            "job_title": "Different title same JD",
            "company": "Other",
            "location": "Calgary",
            "job_description": sample_job["job_description"],
            "job_url": "https://www.linkedin.com/jobs/view/smoke-test-dup-content",
            "easy_apply": False,
        }
        r = await c.post("/jobs/ingest", json=dup_job)
        assert r.status_code == 200, f"POST /jobs/ingest dup → {r.status_code}: {r.text}"
        dup_ing = r.json()
        assert dup_ing["content_duplicate"] is True, dup_ing
        dup_row_id = dup_ing["id"]
        r = await c.get(f"/jobs/{dup_row_id}")
        assert r.status_code == 200
        dup_row = r.json()
        assert dup_row.get("original_job_id") == str(job_id), dup_row
        print(f"  [OK] content-duplicate ingest → original_job_id={dup_row['original_job_id']}")

        # ── e. Start a run log ───────────────────────────────────────
        r = await c.post(
            "/extension/run-log/start",
            json={
                "strategy": "C",
                "search_keyword": "backend engineer",
                "search_location": "Canada",
            },
        )
        assert r.status_code == 200, f"POST /run-log/start → {r.status_code}: {r.text}"
        run_id = r.json()["id"]
        print(f"  [OK] POST /extension/run-log/start → id={run_id}")

        # ── f. Complete the run log ──────────────────────────────────
        r = await c.put(
            f"/extension/run-log/{run_id}",
            json={
                "status": "completed",
                "pages_scanned": 3,
                "scraped": 10,
                "new_jobs": 8,
                "existing": 2,
            },
        )
        assert r.status_code == 200, f"PUT /run-log/{run_id} → {r.status_code}: {r.text}"
        updated = r.json()
        assert updated["status"] == "completed", f"run status: {updated['status']}"
        print(f"  [OK] PUT /extension/run-log/{run_id} → status={updated['status']}")

        # ── g. List run logs ─────────────────────────────────────────
        r = await c.get("/extension/run-log", params={"limit": 5})
        assert r.status_code == 200, f"GET /extension/run-log → {r.status_code}"
        logs = r.json()
        log_ids = [lg["id"] for lg in logs]
        assert run_id in log_ids, f"run {run_id} not in log list"
        print(f"  [OK] GET /extension/run-log → {len(logs)} log(s), run present")

        # ── h. Extension state ───────────────────────────────────────
        r = await c.get("/extension/state")
        assert r.status_code == 200, f"GET /extension/state → {r.status_code}"
        state = r.json()
        assert state["id"] == 1, f"state id: {state['id']}"
        print(f"  [OK] GET /extension/state → id={state['id']}, "
              f"page={state['current_page']}")

        # ── i. Trigger scan with website override ────────────────────
        r = await c.post("/extension/trigger-scan", json={"website": "linkedin"})
        assert r.status_code == 200, f"POST /extension/trigger-scan → {r.status_code}"
        trigger = r.json()
        assert trigger["ok"] is True, f"trigger-scan ok: {trigger}"
        print(f"  [OK] POST /extension/trigger-scan {{website: linkedin}} → {trigger}")

        # ── j. Pending scan (first read — pending + website) ─────────
        r = await c.get("/extension/pending-scan")
        assert r.status_code == 200, f"GET /extension/pending-scan → {r.status_code}"
        pending = r.json()
        assert pending["pending"] is True, f"pending-scan (1st): {pending}"
        assert pending.get("website") == "linkedin", pending
        print(f"  [OK] GET /extension/pending-scan (1st) → {pending}")

        # ── k. Pending scan (second read — cleared) ───────────────────
        r = await c.get("/extension/pending-scan")
        assert r.status_code == 200, f"GET /extension/pending-scan → {r.status_code}"
        pending2 = r.json()
        assert pending2["pending"] is False, f"pending-scan (2nd): {pending2}"
        assert pending2.get("website") is None, pending2
        print(f"  [OK] GET /extension/pending-scan (2nd) → {pending2}")

        # ── l. Trigger scan optional body (no body still works) ───────
        r = await c.post("/extension/trigger-scan")
        assert r.status_code == 200
        r = await c.get("/extension/pending-scan")
        p3 = r.json()
        assert p3["pending"] is True
        assert p3.get("website") is None
        await c.get("/extension/pending-scan")
        print("  [OK] POST /extension/trigger-scan (no body) → pending-scan website=null")

    print("\n  All smoke tests passed.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (AssertionError, httpx.HTTPError) as exc:
        print(f"\n  FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
