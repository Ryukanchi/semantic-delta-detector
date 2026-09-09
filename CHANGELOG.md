# Changelog

## 1.0.2 - 2026-09-09

Semantic Delta 1.0.2 is a targeted correctness patch for CLI input precedence.

### Fixes

- **CLI Input Precedence**: Explicit `--query-*`, `--file-*`, and `--json-*`
  inputs now take precedence over configured default input paths. Invalid or
  incomplete explicit inputs are no longer silently masked by defaults. Existing
  `--before` / `--after` fallback behavior and config-based gating are preserved.

## 1.0.1 - 2026-09-05

Semantic Delta 1.0.1 is a targeted correctness patch addressing comparison precision,
Git comparison fault tolerance, CI configuration handling, and reporting trustworthiness.

### Fixes

- **Filter Comparison & Monetization Evidence**: Removed query-level regex suppression
  that hid valid filter differences, restored token-boundary matching for MRR and ARR
  metrics (including delimited tokens such as `mrr_usd` and `monthly_mrr`) without false
  positives on unrelated terms (`carrier`, `arrival`, `warranty`), and established
  explicit predicate ownership to deduplicate monetization gates cleanly.
- **Root Projection Comparison**: Added comparison for top-level `SELECT` projection
  expressions and `SELECT DISTINCT` modifiers, surfacing root expression shifts as high-risk
  semantic differences while normalizing column order and excluding window specifications
  and grouping expressions evaluated in dedicated engines.
- **Git Per-File Analysis Accounting**: Isolated query comparison failures per file so
  that unanalyzable SQL files (such as empty or comment-only scripts) are tracked as skipped
  under the `analysis` stage rather than aborting the entire Git comparison run.
- **CI Configuration & Operational Exit Codes**: Restored public source-level type
  compatibility for `SeverityThreshold` while rejecting unsupported `critical` thresholds in
  `--fail-on` and `semantic-delta.yml` with descriptive validation. Established distinct
  process exit codes: `0` for success (gate passed), `1` for semantic gate failures, and `2`
  for operational, configuration, or syntax errors. Unknown top-level configuration keys are
  now strictly rejected.
- **Trustworthiness**: Updated zero-finding reports to use conservative, observational
  wording ("No material semantic difference was detected within the analyzed dimensions")
  rather than asserting unqualified formal equivalence.

## 1.0.0 - 2026-08-30

Semantic Delta 1.0.0 is the first stable release of the local-first semantic
risk detector for analytics SQL changes.

### Highlights

- Semantic comparison of analytics SQL with explainable risk, confidence,
  evidence, and recommended actions.
- Direct query and file comparison plus Git-aware multi-file comparison with
  complete analyzed/skipped accounting.
- CLI text, JSON, and simulated PR output with optional CI severity gating.
- Browser-safe semantic Core API without Node.js, Git, Worker, or vendor-parser
  dependencies.
- Opt-in PostgreSQL syntax frontend mapped through Semantic Delta's own SQL IR
  into the existing semantic heuristics and Difference Engine.
- Additive isolated PostgreSQL Worker API with a terminable wall-clock timeout
  and conservative fallback behavior.
- Structural comparison for set operations, window specifications, selected
  CTEs and subqueries, CASE expressions, Boolean grouping, and deterministic
  self-join source roles.
- Hardened resource budgets, package contents, public exports, declarations,
  Git content loading, and Node/browser boundaries.

### Trustworthiness

- Risk estimates semantic impact; confidence expresses analysis certainty. The
  two remain independent.
- Parser, resource, timeout, Worker, and partially modeled-construct uncertainty
  stays visible through limitations and conservative confidence caps.
- Parser failure never becomes an unqualified claim of semantic equivalence,
  and fallback analysis retains semantic risk it already detected.
- Git comparison accounts for every discovered record as analyzed or explicitly
  skipped, including malformed, filtered, unavailable, and non-text inputs.
- The root Node.js API, browser-safe Core API, and opt-in PostgreSQL API have
  deliberate and regression-tested dependency boundaries.

### Public API

- `semantic-delta-detector` — semantic comparison, reporting, and local Git
  discovery/comparison APIs for Node.js.
- `semantic-delta-detector/core` — browser-safe semantic comparison functions.
- `semantic-delta-detector/postgresql` — synchronous and isolated asynchronous
  PostgreSQL hybrid comparison functions for Node.js.

All entrypoints are ESM-only. Vendor AST objects and types are not part of the
public API.

### Known limitations

- Semantic Delta is a heuristic warning system, not a query-equivalence prover,
  SQL validator, lineage engine, or replacement for metric ownership.
- The PostgreSQL hybrid is opt-in and Node.js-only. Its synchronous path cannot
  interrupt a vendor parse already in progress.
- The isolated path can terminate its Worker, but its V8 heap and stack limits
  are not an operating-system or container RSS ceiling.
- Git comparison reads committed refs only, not uncommitted worktree or index
  changes.
- Added and deleted metrics are reported but do not yet receive semantic risk.
- PR-style output is a local/CI preview; Semantic Delta does not publish real PR
  comments.
- Documented SQL-length, AST, set-operation, window, source-graph, Worker, and
  timeout budgets apply. Exceeding them fails closed with visible uncertainty.
