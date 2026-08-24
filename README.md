# Semantic Delta Detector

**Catch metric drift before it becomes a dashboard problem.**

`Changed SQL → Semantic Impact → Why it matters`

![Semantic Delta decision report](docs/assets/decision-report.png)

Semantic Delta is a local-first semantic risk detector for SQL metric changes. It compares changed SQL, explains how the business meaning may have shifted, and gives reviewers evidence and a recommended action.

It is an intentionally heuristic early-warning system—not a SQL validator, equivalence prover, or replacement for metric ownership.

## Why this exists

Two dashboards can both show “active users” while measuring different populations:

- one counts unique users who logged in;
- another counts every login event;
- another includes only recently active paying users.

The SQL may look similar, but the resulting KPIs are not interchangeable. Semantic Delta surfaces that difference before it becomes misleading reporting or a bad product, finance, or growth decision.

## Quick start

The repository uses pnpm 10 and is tested in CI with Node.js 24.

```bash
pnpm install
pnpm run compare -- --example unique-login-users-vs-login-event-rows --pr
```

Example result:

```text
🔴 HIGH RISK
This change alters the meaning of the metric.

Impact: aggregation changes may change what is counted.
Evidence:
- Aggregation changed from COUNT(DISTINCT user_id) to COUNT(*).
Recommendation: Confirm whether the metric is intended to count users or events.
```

## Compare changed SQL between Git refs

The primary MVP workflow compares changed SQL files between two local Git refs:

```bash
pnpm run compare -- \
  --changed-from origin/main \
  --changed-to HEAD \
  --repo ../analytics-repo
```

`--changed-from` is always required. Semantic Delta does not guess a base branch. `--changed-to` defaults to `HEAD`, and `--repo` defaults to the current directory.

The Git workflow is:

```text
Git refs
→ changed-file discovery
→ include/ignore filtering
→ conservative before/after pairing
→ semantic comparison per file
→ aggregate report
→ optional severity gate
```

![Semantic Delta aggregate Git comparison](docs/assets/git-comparison-report.png)

Git mode:

- analyzes modified SQL files and complete renames;
- preserves exact before/after paths for renamed files;
- reports added, deleted, copied, filtered, malformed, or unreadable records as explicit skips;
- preserves ordering and duplicate records;
- guarantees that every discovered record is either analyzed or skipped;
- derives aggregate severity only from files that were actually analyzed.

When no `include` rules are configured, Git mode considers `**/*.sql`. `ignore` rules take precedence over `include` rules.

## Output modes

### Readable aggregate report

```bash
pnpm run compare -- --changed-from origin/main --changed-to HEAD
```

### Simulated PR-style report

```bash
pnpm run compare -- --changed-from origin/main --changed-to HEAD --pr
```

This prints a concise preview only. It does not post a pull-request comment or call the GitHub API.

### Complete JSON report

```bash
pnpm run --silent compare -- \
  --changed-from origin/main \
  --changed-to HEAD \
  --format json
```

JSON retains resolved refs, analyzed findings, skipped records, warnings, and accounting totals.

### Optional severity gating

```bash
pnpm run compare -- \
  --changed-from origin/main \
  --changed-to HEAD \
  --fail-on high
```

Supported thresholds are `low`, `medium`, `high`, and `critical`. The gate uses the highest severity among analyzed files. Skipped files do not trigger semantic failure, and a run with no comparable files exits calmly unless an operational error occurred.

Operational errors remain distinct from semantic gate failures.

## Repository configuration

Create `semantic-delta.yml` in the repository being analyzed:

```yaml
fail_on: high
default_before_path: ./examples/pr-before.sql
default_after_path: ./examples/pr-after.sql
include:
  - metrics/**
  - models/**
ignore:
  - docs/**
  - README.md
```

Precedence and scope:

- CLI `--fail-on` overrides config `fail_on`.
- CLI `--before` and `--after` override `default_before_path` and `default_after_path`.
- `include` and `ignore` apply only to local Git comparison mode.
- Explicit before/after comparisons are not filtered by Git path rules.

## Compare two definitions directly

Semantic Delta also supports explicit pairs and bundled examples:

```bash
# SQL files
pnpm run compare -- --file-a ./query-a.sql --file-b ./query-b.sql

# PR-style before/after preview
pnpm run compare -- \
  --before ./examples/pr-before.sql \
  --after ./examples/pr-after.sql \
  --pr

# Inline SQL
pnpm run compare -- \
  --query-a "SELECT COUNT(DISTINCT user_id) FROM events" \
  --query-b "SELECT COUNT(*) FROM events"

# Bundled low-risk example
pnpm run compare -- --example same-de-users-formatting --pr
```

JSON metric definitions may optionally add `metric_name`, `description`, `team_context`, and `intended_use` alongside the SQL query.

## What the analyzer looks for

Semantic Delta currently reasons about signals such as:

| Change | Example semantic risk |
| --- | --- |
| Aggregation | Unique users become event rows |
| Population filter | Paid users become all users |
| Time window | 7-day activity becomes 30-day activity |
| Join behavior | `LEFT JOIN` becomes `INNER JOIN` |
| Source table | Orders become payments |
| Geography or cohort | German users become US users |
| Exclusion filter | Internal, test, or deleted users enter the metric |
| Reporting grain | Daily counts become monthly counts |

Formatting-only or semantically equivalent changes should remain low risk, reducing alert fatigue and making higher-severity findings more useful.

Trustworthiness guardrails keep uncertainty explicit:

- empty, whitespace-only, and comment-only SQL inputs are rejected instead of being reported as low risk;
- partially modeled CTE and CASE constructs cap confidence at `medium`, while detected subqueries cap it at `low`;
- parser limitations reduce confidence without automatically increasing semantic risk;
- unknown CLI options and unsupported positional arguments fail with an error instead of being ignored.

## Safe local Git boundary

Git integration is deliberately conservative:

- subprocesses use argument arrays with no shell interpolation;
- raw refs are resolved before content loading;
- only repository-verified commit objects reach `git show`;
- discovery uses NUL-delimited `git diff --name-status -z` output;
- Unicode, spaces, tabs, newlines, quotes, backslashes, and rename paths are preserved exactly;
- malformed framing fails transactionally instead of inventing record boundaries;
- binary, NUL-containing, and invalid UTF-8 content never becomes fake SQL text;
- public APIs cannot replace the trusted internal Git runner.

See [Git discovery design](docs/design/git-discovery.md) for the detailed invariants.

## Programmatic API

The default package entry point includes the semantic engine plus Node.js Git discovery and comparison APIs:

```ts
import {
  compareGitChanges,
  compareMetricDefinitions,
  compareSqlQueries,
} from "semantic-delta-detector";
```

Browser and extension consumers can import the semantic engine without Node.js filesystem or subprocess dependencies:

```ts
import {
  compareMetricDefinitions,
  compareSqlQueries,
} from "semantic-delta-detector/core";
```

## GitHub Actions preview

`.github/workflows/semantic-delta-preview.yml` runs tests, builds the project, and prints a simulated PR-style report in CI logs.

Current workflow scope:

- pull-request runs are non-blocking and use the bundled demo SQL files;
- manual runs can use explicit before/after paths or config defaults;
- manual runs can demonstrate `fail_on` gating;
- no GitHub API credentials or real PR-comment posting are used.

## VS Code extension

Run the same browser-safe semantic core directly in VS Code:

[Ryukanchi/semantic-delta-extension](https://github.com/Ryukanchi/semantic-delta-extension)

## Current limitations

- SQL understanding is heuristic; there is no full SQL AST parser.
- Complex SQL such as CTEs and subqueries is only partially modeled.
- Added and deleted metrics are observable but do not yet receive semantic risk.
- Git mode compares committed refs, not uncommitted worktree or index changes.
- The project does not post real pull-request comments.

## Status

**Usable local Git comparison MVP with a browser-safe semantic core.**

The comparison engine, Git discovery boundary, aggregate reporting, configuration, JSON output, and optional gating are implemented and tested. SQL understanding remains intentionally heuristic and continues to evolve.
