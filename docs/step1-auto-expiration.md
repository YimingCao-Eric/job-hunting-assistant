# Step 1 — Auto-expiration (global shelf life)

Per-source scrape rows (**`linkedin_jobs`**, **`indeed_jobs`**, **`glassdoor_jobs`**) are deleted when older than configurable **`shelf_life_days`**, regardless of the **`matched`** flag.

## Configuration

- Table **`system_settings`** (migration **029**): key **`shelf_life_days`**, string value (integer days), seeded default **`7`**.
- Accessor: **`backend/core/system_settings.py`** — **`get_shelf_life_days`** coerces to int and falls back to **`7`** on parse failure.

## SQL pattern

```sql
DELETE FROM <table>
WHERE scrape_time < NOW() - make_interval(days => :days);
```

Runs for all three tables inside one logical transaction when invoked from **`run_auto_expiration`** (caller supplies **`async with db.begin():`**).

## Orchestrator integration (ordering)

When **`run_post_scrape_phase`** runs after **`scrape_complete`**, phases execute in this order:

1. **Auto-expiration** — deletes aged rows; persists **`cleanup_results`** on the cycle (`deleted_per_table`, `shelf_life_days`).
2. **Matched-claim** — **`UPDATE … SET matched = TRUE`** for unmatched rows; **`claim_summary`** merged into **`match_results`** later on the success path.
3. **Dedup / matching** (stubs today) — future work.

## Transaction boundaries

**Auto-expiration** and **matched-claim** each use **their own** `async with AsyncSessionLocal() as db:` + `async with db.begin():` block. They do **not** share one transaction: failure in one phase does not roll back the other.

See **`matched-mechanism-codebase-changes-corrected.md`** §14 for lifecycle diagram and **`step1-schema-design.md`** §15 for limitations.
