# Step 2 — Dedup design

## Pass 0 (metadata / title / company / location)

Blacklist, job-type, and agency company checks before the JD is considered.

## Pass 1 (JD text gates)

Language detection is **not** part of dedup Pass 1. It runs in Step 3 matching **`run_cpu_work()`** (Button 1) as a CPU gate on the JD, with `match_skip_reason='language'` and `removal_stage='cpu_work'`.

| Gate | Description |
|-------------------|-------------|
| title_mismatch    | Title must match configured target titles when targets are set |
| contract_mismatch | Contract / temp roles when `no_contract` is enabled |
| remote_mismatch   | Onsite / in-office signals when `remote_only` is enabled |
| sponsorship       | No-sponsorship phrases when `needs_sponsorship` is enabled |
| agency_jd         | Agency-style JD phrases when `no_agency` is enabled |

## Pass 2

Hash-exact and cosine similarity deduplication (see `backend/dedup/service.py`).

## skip_reason reference (excerpt)

| skip_reason / match | Set by | Notes |
|---------------------|--------|--------|
| `language`          | Matching CPU gates (`match_skip_reason`) | **No longer set by dedup.** Legacy dedup reports may still contain a `language` key in `gate_results` JSON; clients should ignore it. |
