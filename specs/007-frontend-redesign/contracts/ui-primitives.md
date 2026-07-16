# Contract: Shared UI Primitives

**Feature**: 007-frontend-redesign | **Date**: 2026-07-15

`components/ui/` is the **sole owner of visual treatment**. This contract fixes the primitives' props and the rules that make FR-007 – FR-009, FR-011, FR-013, and SC-005 – SC-007 verifiable rather than aspirational.

**The enforcing rule**: no file outside `components/ui/` and `tailwind.config.ts` may contain a color, spacing, radius, shadow, or font-size value. Pages and feature components compose primitives and pass **semantic** props (`tone="danger"`), never presentational ones (`className="bg-red-600"`). SC-006 ("zero one-off color or spacing values exist outside the shared token set") is checked against this rule.

**Why this is stated so bluntly**: the current code proves the failure mode. `SessionHealth.tsx:37-45` inlines a 5-branch ternary of raw classes (`bg-green-500`/`bg-yellow-500`/`bg-red-500`/`bg-red-600`/`bg-gray-400` — note two near-identical reds for `captcha` vs `expired`), and the same button class string `px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50` is copy-pasted across three files. Both are exactly what a primitive exists to prevent.

---

## Tokens (`tailwind.config.ts` → `theme.extend`)

The single token set (FR-007). `preflight` is **re-enabled** — it was disabled only to stop Tailwind's reset colliding with the CSS modules, which no longer exist.

| Group | Contents |
|---|---|
| `colors.surface` | `page`, `card`, `raised`, `overlay` |
| `colors.border` | `default`, `strong` |
| `colors.text` | `primary`, `secondary`, `muted`, `inverse` |
| `colors.accent` | `default`, `hover`, `subtle` |
| `colors.success` / `warning` / `danger` / `info` | `default`, `hover`, `subtle`, `text` |
| `spacing` | **inherit Tailwind's scale — do not re-declare.** It is already a token set; redefining it creates a second one |
| `borderRadius` | `sm`, `md`, `lg` |
| `fontFamily.sans` | DM Sans (already loaded in `index.html`) |
| `fontSize` | `xs`…`2xl` |
| `boxShadow` | `card`, `overlay` |

### Semantic maps

Status → tone lives **next to the token set**, not inside components. This is what makes SC-007 ("visual treatment maps to consequence") checkable in one place.

```ts
// lib/tokens/semantics.ts
export const PROBE_TONE: Record<ProbeStatus, Tone> = {
  live: 'success', expired: 'danger', captcha: 'danger',
  rate_limited: 'warning', unknown: 'neutral',
};

export const RUN_TONE: Record<string, Tone> = {
  running: 'info', completed: 'success', failed: 'danger',
};
// RunLog.status is free text with no DB constraint — unknown values fall back to 'neutral'.

export const CYCLE_TONE: Record<CycleStatus, Tone> = {
  scrape_running: 'info', scrape_complete: 'success',
  postscrape_running: 'info', post_scrape_complete: 'success',
  failed: 'danger',
};

export const HEARTBEAT_TONE: Record<HeartbeatGrade, Tone> = {
  fresh: 'success', aging: 'warning', stale: 'danger', never: 'neutral',
};
```

**FR-038's rule is a tone rule**: a stale heartbeat (`danger`) and a deliberate pause (`neutral`) must never share a treatment. `enabled: true` + `stale` is the alarming combination and must be unmistakable at a glance.

---

## Primitives

### `Button`

```ts
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'destructive';
  size?: 'sm' | 'md';
  busy?: boolean;        // renders Spinner + disables; the ONLY in-button loading affordance
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  type?: 'button' | 'submit';
}
```

- **FR-011 / SC-007**: `variant="destructive"` is visually distinct from `primary` **without reading the label** — different fill, not just a different word. It is the only variant permitted for stop-a-scan, stop-and-exit, and reset-a-session, and **every use must be paired with `ConfirmDialog`**.
- `busy` implies `disabled`. Re-enable is guaranteed in a `finally` — this is the one pattern worth porting verbatim from the old `StatusHeader.tsx:71-83` `wrap` HOF.
- No `className` escape hatch. If a caller needs a look the variants don't offer, the variant set is wrong — fix it here.

### `ConfirmDialog`

```ts
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone: 'default' | 'destructive';
  onConfirm: () => void;
  onCancel: () => void;
}
```

FR-011's other half. Required by: **stop a scan** (`POST /extension/trigger-stop` — immediately fails **all** running run-logs), **stop-and-exit** (`POST /shutdown`), **reset a site session** (`POST /reset-session/{site}`). Also serves FR-020's unsaved-changes warning via `useUnsavedGuard`.

**Never use `window.confirm`** — it is unstyleable, untestable, and inconsistent with every other surface.

### `Badge`

```ts
interface BadgeProps {
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  children: ReactNode;
}
```

Callers pass `tone={PROBE_TONE[s.last_probe_status]}` — never a raw color. This single line is what replaces `SessionHealth.tsx:37-45`.

### `Table`

```ts
interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'left' | 'right';
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyState?: ReactNode;     // rendered in place of the body when rows is empty
}
```

**FR-006 / SC-012 (360px, no horizontal scrolling) is this component's responsibility.** Every table in the app goes through it, so the narrow-viewport strategy is implemented once: the table scrolls **within its own container**, and the page body never scrolls horizontally. Per-page table markup would mean solving this four times and getting it right maybe twice.

### `Spinner`, `PageTitle`, `Card`

```ts
interface SpinnerProps  { size?: 'sm' | 'md' | 'lg'; label?: string }   // label → aria-label
interface PageTitleProps { title: string; actions?: ReactNode }
interface CardProps      { title?: string; actions?: ReactNode; children: ReactNode }
```

`Card` replaces the `<div className="bg-white border rounded-lg p-6 shadow-sm">` string repeated verbatim across five auto-scrape files. `Spinner` and `PageTitle` replace the two entirely inline-styled components — the old `Spinner` also depended on a `@keyframes spin` declared in a global `index.css`, a coupling the primitive removes.

### `TopNav`

```ts
// No props. Renders NAV_ITEMS.
```

- **FR-002**: horizontal, top, on every page; the current destination is unambiguous. **Page content retains full viewport width** — no side rail. (The old `Sidebar.tsx` is deleted, not restyled.)
- **FR-003**: renders `NAV_ITEMS` from `lib/nav.ts`, the same array `router.tsx` builds routes from. **One array is the sole source of both**, so nav and routes cannot drift. FR-001 becomes a property of its length; FR-004 a property of its contents.
- **SC-003** (any page reachable from any other in one click) is satisfied by construction: all four are always present.

---

## State components (`components/ui/states/`)

**These three are the mechanism for FR-009 and SC-005** — *"a reviewer comparing any two pages finds no structural difference in how these states appear"*. Same placement, same structure, same tone, because it is literally the same component. A page that hand-rolls a loading `<div>` is the defect these prevent.

### `LoadingState`

```ts
interface LoadingStateProps { label?: string }
```

**FR-012**: shown while `isPending` — i.e. *never resolved*, distinct from *resolved empty*. Rendering an empty state before the first result is the specific bug this forbids.

**FR-015**: **not** rendered on background refetch. Refetches update in place; `placeholderData: keepPreviousData` keeps the previous data on screen. A page that flips to `LoadingState` on a poll tick is an FR-015 violation.

### `EmptyState`

```ts
interface EmptyStateProps {
  kind: 'no-data' | 'no-match';   // FR-013 — these are DIFFERENT states
  title: string;
  body?: ReactNode;
  onClearFilters?: () => void;    // REQUIRED when kind === 'no-match'
}
```

**FR-013** requires distinguishing "no data exists" from "no data matches the current filters", and the filtered-empty state **must** offer a way to clear filters. The prop shape enforces the pairing: `kind="no-match"` without `onClearFilters` is a type error, not a review comment.

| Page | `no-data` | `no-match` |
|---|---|---|
| Jobs | "No jobs scraped yet — run a scan." | "No jobs match these filters." + Clear |
| Logs | "No runs recorded yet." | "No runs with this status." + Clear |
| Auto-Scrape | "No cycles yet." | n/a (no filters) |

Also used for two narrower cases: a run with **no recorded trace** (FR-036 — an explicit state, *"rather than an empty panel"*) and no active cycle.

### `ErrorState`

```ts
interface ErrorStateProps {
  error: ApiError;
  onRetry: () => void;   // REQUIRED — FR-014 mandates a retry
}
```

**FR-014**: states what failed (`error.message`, always human-readable — see [error-model.md](./error-model.md)) and offers retry. `onRetry` is non-optional, so a retry-less error state cannot be written.

#### The composition rule (page-level vs per-query)

Two requirements pull in opposite directions and the rule below reconciles them. The spec's "Backend unreachable" edge case says every page shows **"a page-level error state"**; FR-015 and the per-query design say a failed `cycles` fetch must **not** blank a healthy `state`. Both are right, in different cases:

| Condition | Presentation |
|---|---|
| **ALL** of a page's queries fail with `kind: 'network'` | **ONE page-level `ErrorState`**, replacing the page body. `onRetry` refetches every failed query. The backend is unreachable — N stacked identical "could not reach the backend" cards would be noise, and the spec asks for a page-level state here. |
| A **SUBSET** of queries fails | **Per-query `ErrorState`, scoped to that section.** The rest of the page keeps rendering. A failed `cycles` fetch shows an error **in the cycles card** while `state` and `sessions` render normally. |
| Failures are **non-network** (422 validation, 409 conflict, 404, 500) | **Always per-query / per-control**, never page-level — even if every query fails. These are specific, actionable, and differ per surface; collapsing them into one page-level message would destroy the specific reason FR-016 requires. Validation errors surface as `fieldErrors` on the field, not as an `ErrorState` at all. |

Rationale for the network/non-network split: "the backend is down" is **one fact** and deserves one statement; "these four things each failed differently" is **four facts** and deserves four. The discriminator is `kind === 'network'` (equivalently `status === 0`), which the normalizer already assigns.

**The anti-pattern this replaces**: the old `auto-scrape/page.tsx:59-65` blanks the entire UI when **any one** of five parallel calls fails — a single transient 500 on `cycles` hides a perfectly healthy `state` and `sessions` until the next 5s tick. That is the subset case, handled page-level. Wrong in exactly the way the middle row above forbids.

**SC-008** (backend unreachable → stated error + retry within 10s on 100% of pages, none hanging, none showing a misleading empty state) follows from `kind: 'network'` reaching this component on every page, via the first row.

**401 does not reach here.** `kind === 'unauthorized'` is handled once in the shell.

---

## Composition rules

| # | Rule | Enforces |
|---|---|---|
| 1 | Pages compose primitives; they never style | FR-007, SC-006 |
| 2 | No `className` passthrough on primitives — a missing look means a missing variant | FR-008 |
| 3 | Semantic props only (`tone="danger"`), never presentational (`className="bg-red-600"`) | SC-007 |
| 4 | Status → tone comes from `lib/tokens/semantics.ts`, never an inline ternary | FR-007, SC-007 |
| 5 | Loading/empty/error come **only** from `states/` — no hand-rolled `<div>Loading…</div>` | FR-009, SC-005 |
| 5a | Error scoping follows the composition rule: all-queries-fail + network ⇒ one page-level `ErrorState`; subset or non-network ⇒ per query | FR-014, FR-015, SC-008 |
| 6 | `variant="destructive"` ⇒ paired `ConfirmDialog`. No exceptions | FR-011, SC-007 |
| 7 | `EmptyState kind="no-match"` ⇒ `onClearFilters` (type-enforced) | FR-013 |
| 8 | `ErrorState` requires `onRetry` (type-enforced) | FR-014 |
| 9 | Tables scroll within their container; the page body never scrolls horizontally at 360px | FR-006, SC-012 |
| 10 | Feature components stay ~100 lines and split container/presenter | The stated quality bar (`components/auto-scrape/*`, avg ~100 lines vs 1,166–1,524 for the JSX pages) |
