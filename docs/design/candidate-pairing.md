# Candidate Pairing Design

## 1. Problem

Semantic Delta can compare explicit before/after SQL files today through `--before` and `--after`.

Future changed-file discovery will produce candidate paths. Those paths are not automatically safe to compare. A changed path might represent a normal modification, a newly added file, a deleted file, a rename, or a file that does not have SQL content on both sides.

Candidate paths need to become safe compare-ready before/after pairs before the semantic comparison engine runs. Not every changed path is comparable, and the tool should avoid pretending otherwise.

## 2. Goals

- Produce compare-ready pairs only when both before and after content exist.
- Provide clear skipped reasons for non-comparable paths.
- Keep behavior predictable in CI logs.
- Avoid false confidence for new, deleted, or renamed files.
- Keep candidate pairing separate from Git discovery at first.
- Preserve the explicit `--before` / `--after` workflow as the simplest path.

## 3. Non-Goals

- No Git implementation in this design.
- No GitHub API behavior.
- No PR comments.
- No dbt-specific pairing yet.
- No automatic metric identity matching yet.
- No repository scanning behavior.

## 4. Candidate Input Model

A future Git discovery layer can produce a normalized candidate shape before pairing.

Example:

```ts
type CandidateFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  beforePath?: string;
  afterPath?: string;
  hasBefore: boolean;
  hasAfter: boolean;
};
```

Intended meanings:

- `path`: the primary display path for logs and summaries.
- `status`: the source change type reported by discovery.
- `beforePath`: path to use for the before side when different from `path`.
- `afterPath`: path to use for the after side when different from `path`.
- `hasBefore`: whether before content is available.
- `hasAfter`: whether after content is available.

This keeps Git-specific details out of the pairing helper. Git discovery can later decide how to populate `beforePath`, `afterPath`, `hasBefore`, and `hasAfter`.

## 5. Output Model

Candidate pairing should return both compare-ready pairs and skipped candidates.

Example:

```ts
type CandidatePair = {
  beforePath: string;
  afterPath: string;
  displayPath: string;
};

type SkippedCandidate = {
  path: string;
  reason: string;
};

type CandidatePairingResult = {
  pairs: CandidatePair[];
  skipped: SkippedCandidate[];
};
```

`pairs` are safe to pass to the comparison layer. `skipped` entries are safe to print in CI logs.

## 6. Initial Policy

Recommended initial behavior:

- Modified files with before and after content become pairs.
- Added files are skipped with reason: `skipped: no before version`.
- Deleted files are skipped with reason: `skipped: no after version`.
- Renamed files are skipped initially unless both sides are confidently available.
- Unknown statuses are skipped.
- Paths already excluded by `include` / `ignore` should not reach pairing, or should be marked skipped by the filtering layer before pairing.

The first pairing helper should be conservative. It should only produce a pair when the two sides are obvious.

## 7. Rename Handling

Renames are tricky because path identity and metric identity are not always the same.

A renamed SQL file might represent:

- the same metric moved to a new location,
- a model split or consolidation,
- a new metric replacing an old one,
- a refactor where the file path changed but the semantic definition did not.

The initial version should either skip renames or pair them only when `beforePath` and `afterPath` are explicit and both sides are available.

A later improvement could compare renamed files with an extra warning, for example: `rename detected; confirm this path change preserves metric identity`.

## 8. CI Log UX

CI output should make pairing behavior visible.

Recommended output:

- Print compare-ready pairs before analysis.
- Print skipped candidates and reasons.
- Avoid silently ignoring files.
- Keep skipped output concise.
- Group skipped reasons when many files share the same reason.

Example log shape:

```text
Semantic Delta candidate pairs:
- models/revenue.sql

Skipped candidates:
- models/new_metric.sql: skipped: no before version
- models/old_metric.sql: skipped: no after version
```

## 9. Future CLI / Workflow Integration

A later automated flow could look like this:

1. Discover changed files.
2. Apply `include` / `ignore` filtering.
3. Create candidate pairs.
4. Compare each pair.
5. Print an aggregate report.
6. Optionally fail on a configured threshold.

This should still start with CI log output. Real PR comments should be considered only after discovery, filtering, pairing, and summary behavior are predictable.

## 10. Open Questions

- Should added SQL files be reported as new metrics?
- Should deleted SQL files be reported as removed metrics?
- Should renamed files be compared with a warning?
- How should multiple SQL files contributing to one metric be handled?
- Should dbt model metadata influence pairing?
- Should candidate pairing understand file extensions, or should filtering handle that before pairing?
- Should skipped candidates affect CI status when `fail_on` is configured?

## 11. Recommended Next Implementation Step

Implement a pure candidate pairing helper after this design.

Suggested scope:

- No Git calls.
- No filesystem scanning.
- No CLI behavior change.
- Input is a list of normalized `CandidateFile` objects.
- Output is `pairs` and `skipped`.
- Add tests for modified, added, deleted, renamed, missing-before, missing-after, and unknown-status candidates.
- Keep skipped reasons transparent and stable enough for CI logs.

After that helper exists, a future Git discovery layer can feed candidates into filtering and pairing without coupling Git behavior to semantic comparison.
