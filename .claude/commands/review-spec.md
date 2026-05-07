---
description: Five-axis adversarial review of a design spec. Dispatches 5 parallel reviewers (architecture, drift, cost, scope, taste) and writes a synthesized report to docs/superpowers/reviews/.
argument-hint: [spec-path] (optional, defaults to most recent in docs/superpowers/specs/)
allowed-tools: Read, Glob, Bash, Agent, Write, TodoWrite
---

# Adversarial spec review (5 parallel reviewers)

Run a structured multi-axis review of a design spec. Each reviewer focuses on one axis, runs in parallel, returns evidence-based findings. You synthesize and write a report.

## Step 1 — Resolve the spec path

If `$ARGUMENTS` is non-empty, treat it as the spec path. Verify with `Read` (top of file).

If `$ARGUMENTS` is empty, find the most recent spec:

```bash
ls -t docs/superpowers/specs/*.md 2>/dev/null | head -1
```

Verify the resolved file exists and is at least 500 chars (`wc -c`). If the file is missing or tiny, stop and tell the user the path is invalid; do not dispatch reviewers against an empty file.

Capture two values for downstream steps:
- `SPEC_PATH` — absolute or workspace-relative path
- `SPEC_BASENAME` — filename without `.md` extension

## Step 2 — Dispatch all 5 reviewers in parallel

In **a single message**, send 5 `Agent` tool calls. Each prompt must include `SPEC_PATH` so the agent reads the right file.

| # | subagent_type | Prompt skeleton |
|---|---|---|
| 1 | `spec-architect` | "Review the spec at `<SPEC_PATH>` for technical fit against the existing codebase at the project root. Find conflicts with existing schema, route mounts, dependencies, and IPC assumptions." |
| 2 | `spec-drift` | "Verify all 'shipped' and 'existing' claims in the spec at `<SPEC_PATH>` against the actual code at the project root. Per-claim VERIFIED/DRIFT/FALSE verdicts." |
| 3 | `spec-cost` | "Audit cost and resource assumptions in the spec at `<SPEC_PATH>`. Use WebSearch for current pricing. Show the math." |
| 4 | `spec-scope` | "Adversarial scope review of the spec at `<SPEC_PATH>`. Find hidden complexity, optimistic estimates, punted hard problems, missing failure modes, race conditions, testing gaps." |
| 5 | `spec-taste` | "Frontend and visual taste audit of the spec at `<SPEC_PATH>`. If no frontend section exists, return n/a." |

Run them in parallel — single message, 5 Agent calls. Do not sequence them. If you call them serially, you've broken the command.

## Step 3 — Synthesize findings

When all 5 agents return:

1. **Group findings by severity** — BLOCKER → HIGH → MEDIUM → LOW (use the agents' tags; map "critical" → BLOCKER if needed)
2. **Dedupe** — when multiple reviewers caught the same issue, merge into one entry and note "(caught by N reviewers)"
3. **Pull out "confirmed clean" items** from the drift reviewer's VERIFIED claims — these reduce reader anxiety

## Step 4 — Write the report

Write to `docs/superpowers/reviews/<SPEC_BASENAME>-review-<YYYY-MM-DD>.md`. The directory exists. If running multiple reviews on the same spec the same day, append a numeric suffix (`-2`, `-3`).

Report structure:

```markdown
# Review — <SPEC_BASENAME>

Date: <YYYY-MM-DD>
Reviewed: `<SPEC_PATH>`
Reviewers: spec-architect, spec-drift, spec-cost, spec-scope, spec-taste

## Summary

<N> blockers · <N> high · <N> medium · <N> low

## Blockers

<grouped, deduped findings with file:line evidence and "caught by N" annotations>

## High priority

...

## Medium

...

## Low

...

## Confirmed clean

<verified spec claims that match code reality, in one bullet each>

---

## Per-reviewer raw output

### spec-architect

<verbatim agent output>

### spec-drift

<verbatim>

### spec-cost

<verbatim>

### spec-scope

<verbatim>

### spec-taste

<verbatim>
```

## Step 5 — Surface to user

Print exactly this in the conversation, no more than 8 lines:

```
Review complete: <N> blockers · <N> high · <N> medium · <N> low

Top issues:
  1. <one-line title>  (caught by <N>)
  2. <one-line title>
  3. <one-line title>

Full report: docs/superpowers/reviews/<basename>-review-<date>.md
Next: revise spec to address findings, or accept and proceed.
```

## Step 6 — Stop

Do not auto-revise the spec. Do not invoke writing-plans. Hand back to the user.
