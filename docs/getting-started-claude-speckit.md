# Getting started — Claude Code + GitHub Spec Kit (from zero)

> How this project (JHA) was bootstrapped, and how to stand up a **new** repo — e.g. the standalone
> filter-matcher — the same way. Written for **Windows / PowerShell**. These are the exact choices
> JHA uses: AI agent = **Claude**, script type = **Python**, slash commands in the **hyphen** form
> (`/speckit-specify`). Install commands change over time — confirm the latest at the official
> sources linked in each step.

---

## 0. What you're setting up, and why

| Piece | What it is |
|---|---|
| **Claude Code** | The command-line agent that reads/writes code and runs the workflow. Docs: `https://docs.claude.com`. |
| **GitHub Spec Kit** | Spec-Driven Development (SDD) scaffolding: a project **constitution**, per-feature **specs**, and the `/speckit-*` slash commands. Repo: `https://github.com/github/spec-kit`. |

**The idea (SDD):** you don't jump straight to code. You write down *what* and *why* (spec), agree
*how* (plan), break it into *tasks*, and only then *implement* — with an **analyze** gate that
cross-checks all of it against the constitution before any code is written. The payoff is that
mistakes get caught in cheap documents instead of expensive code.

---

## 1. Prerequisites

Install these first (once per machine):

- **Git** and a repository (or an empty folder you'll `git init`).
- **Node.js LTS** (for Claude Code) — `https://nodejs.org`.
- **Python 3.11+** and **[uv](https://github.com/astral-sh/uv)** (for Spec Kit's `specify` CLI and
  its Python helper scripts).
- An **Anthropic account** for signing in to Claude Code.

Verify in PowerShell:

```powershell
git --version
node --version
python --version
uv --version
```

---

## 2. Install and launch Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
```

Then open your project and start it:

```powershell
cd "D:\path\to\your-repo"
claude
```

On first run it will prompt you to sign in. (If `npm install -g` is blocked, check the current
install method at `https://docs.claude.com` — it may offer a native installer.)

> Launch `claude` **from inside the repo folder** — it operates on the current directory.

---

## 3. Initialize GitHub Spec Kit

Spec Kit ships a `specify` CLI. Install it with uv (confirm the exact command at the
[spec-kit README](https://github.com/github/spec-kit)):

```powershell
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git
# or run it one-off without installing:
# uvx --from git+https://github.com/github/spec-kit.git specify init --here
```

Initialize **inside your repo**:

```powershell
specify init --here          # scaffolds into the current folder
# or:  specify init my-new-project   # creates a new folder
```

It asks two questions — answer them the way JHA did:

1. **AI agent →** `Claude`
2. **Script type →** `Python (py)`

What it creates:

```
.specify/
  ├── memory/constitution.md     your project's coding standards (starts as a template)
  ├── templates/                 spec / plan / tasks / checklist templates
  └── scripts/                   Python helpers the commands call
.claude/
  └── commands/ (or skills/)     the /speckit-* slash commands, wired for Claude
```

Commit the scaffolding so it's tracked:

```powershell
git add .specify .claude
git commit -m "Initialize GitHub Spec Kit (Claude + Python)"
```

> **Command form:** in this setup the slash commands are **hyphenated** — `/speckit-constitution`,
> `/speckit-specify`, etc. (Some Spec Kit versions use a dot, `/speckit.specify`.) Use whichever
> your install registered; type `/` in Claude Code to see the list.

---

## 4. The SDD loop — the commands, in order, and what each delivers

Run these **inside Claude Code** (they're slash commands). Do `constitution` once per repo; run the
rest per feature.

| # | Command | Delivers |
|---|---|---|
| 0 | `/speckit-constitution` | The project's **coding standards / principles** (append-only rules, testing discipline, etc.). Written once; amended rarely, with a version bump. |
| 1 | `/speckit-specify` | The **feature spec** — *what* and *why*, functional requirements (FR) and success criteria (SC). No implementation detail. |
| 2 | `/speckit-clarify` | A short **Q&A** that resolves ambiguities in the spec before planning. |
| 3 | `/speckit-checklist` | A **quality gate on the spec** — tests whether requirements are complete, falsifiable, unambiguous. |
| 4 | `/speckit-plan` | The **technical plan** — *how* it's built, following the constitution. |
| 5 | `/speckit-tasks` | The **task breakdown** — an ordered, checkable task list. |
| 6 | `/speckit-analyze` | The **gate**: cross-checks spec ↔ plan ↔ tasks ↔ constitution for gaps and contradictions. Resolve findings *before* implementing. |
| 7 | `/speckit-implement` | **Builds it** — writes the code and tests against the spec. |

Each feature gets its own folder under `specs/NNN-feature-name/` (spec, plan, tasks, research,
contracts, checklists).

---

## 5. Windows / PowerShell notes

- Run everything in **PowerShell** (not cmd).
- Paste commands **one per line** — chaining with newlines can fuse tokens (e.g. `-A` and `git`
  colliding). If you must one-line, separate with `;`.
- Quote paths with spaces: `cd "D:\cym\work\...\your-repo"`.

---

## 6. Your first feature, end to end

```
/speckit-constitution        # once: write your standards
/speckit-specify  <describe the feature in plain language>
/speckit-clarify             # answer the questions
/speckit-checklist           # fix what it flags
/speckit-plan
/speckit-tasks
/speckit-analyze             # resolve findings BEFORE implementing
/speckit-implement
```

Three habits that repeatedly paid off on this project:

- **Read the clause, not the summary.** For any spec/governance question, quote the actual text —
  summaries mislead.
- **Verify on real data, not inference.** A live run beats "the logic looks right"; claims about
  state (row counts, rendered output) get checked, not assumed.
- **Don't accept vacuous green.** Confirm a test/step actually ran rather than silently skipping.

---

## 7. Bootstrapping the filter-matcher repo with this

The standalone filter-matcher is a **separate repo with its own constitution**. To start it:

```powershell
cd "D:\path\to\filter-matcher"      # a fresh repo
git init
claude
```

Inside Claude Code:

```
specify init --here          # (run from the shell, or let Claude run it) → Claude, Python
/speckit-constitution        # the service's own standards, separate from JHA's
/speckit-specify  <feed in docs/filter-matching-service-design.md as the source>
```

Then continue the loop. See `docs/filter-matching-service-design.md` for the design and
`docs/PROJECT-SUMMARY.md` for how JHA used this exact workflow across ten features.
