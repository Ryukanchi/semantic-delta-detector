# I built a semantic SQL diff tool because COUNT(DISTINCT user_id) and COUNT(*) can break dashboards

## The Problem

SQL metric changes can look small in a code diff while changing the meaning of a KPI.

A reviewer may see one line change from `COUNT(DISTINCT user_id)` to `COUNT(*)` and understand the syntax immediately. What is easier to miss is the semantic change: the metric may no longer count users. It may now count rows.

That kind of change can quietly break dashboards, experiments, and recurring business reports. The SQL still runs. The chart still renders. The metric name may stay the same. But the number now answers a different question.

Semantic Delta is an MVP TypeScript semantic risk engine for SQL metric changes. It tries to flag changes that look safe but may silently alter KPI meaning.

It is heuristic by design. It is not a SQL validator, not a metric governance platform, and not a replacement for human metric ownership.

## Why Normal Diffs Are Not Enough

Normal diffs are excellent at showing text changes. They are less helpful at explaining whether a SQL change still measures the same business concept.

For analytics SQL, the risky part is often not whether a query is syntactically valid. The risky part is whether a dashboard metric has changed from:

- unique users to event rows
- paid users to all users
- daily reporting to monthly reporting
- optional relationships to required relationships
- one source-of-truth table to another

Those changes may be intentional. But if they are intentional, they should be visible in review.

Semantic Delta tries to turn those changes into a compact Verdict + Impact report with evidence and a suggested reviewer action.

## Example 1: Unique Users vs Event Rows

```sql
-- Before
SELECT COUNT(DISTINCT user_id)
FROM events
WHERE event = 'login';
```

```sql
-- After
SELECT COUNT(*)
FROM events
WHERE event = 'login';
```

Both queries involve login activity. Both may be labeled as a login metric. But they do not count the same thing.

The first query counts unique users who logged in. The second counts login event rows. If one user logs in five times, the second query can count five rows while the first counts one user.

Expected risk: high.

Why it matters: this can change product engagement reporting, active-user dashboards, and experiment readouts without an obvious failure mode.

## Example 2: Paid Users vs All Users

```sql
-- Before
SELECT COUNT(*)
FROM users
WHERE plan = 'paid';
```

```sql
-- After
SELECT COUNT(*)
FROM users;
```

This change removes the paid-plan filter. The result may still be a user count, but the population has changed.

Expected risk: high.

Why it matters: a metric that previously represented paying users may now represent the entire user base. That can distort revenue, retention, conversion, and growth discussions.

## Example 3: CI Gating

Semantic Delta can run locally and in a GitHub Actions preview workflow.

For example, a local PR simulation can compare two SQL files and print a PR-style review comment:

```bash
npm run compare -- --before ./examples/pr-before.sql --after ./examples/pr-after.sql --pr
```

Optional severity gating can be enabled with a threshold:

```bash
npm run compare -- --before ./examples/pr-before.sql --after ./examples/pr-after.sql --pr --fail-on high
```

Without a threshold, the command can be used as a non-blocking review aid. With a threshold, teams can experiment with failing CI only for changes above a chosen severity.

This is currently a preview workflow and local simulation. It does not post real GitHub PR comments yet.

## How Semantic Delta Works Today

Semantic Delta reads two SQL-backed metric definitions and extracts signals such as:

- selected expressions
- aggregations
- tables
- filters
- time windows
- join behavior
- inferred business dimensions

It then compares the two profiles and reports likely semantic risk.

Current capabilities include:

- 12 semantic risk cases
- low-risk equivalence handling for formatting-only or semantically equivalent changes
- Verdict + Impact report output
- PR-style comment formatting
- local PR simulation
- GitHub Actions preview
- optional CI severity gating
- `semantic-delta.yml` config foundation

The aim is to act like an early warning system during review. It should help humans notice semantic drift, not pretend to prove the correct metric definition.

## Current Limitations

Semantic Delta is still an MVP.

Important limitations:

- SQL understanding is heuristic and still evolving.
- It does not prove query equivalence.
- It does not know your organization's metric definitions unless they are expressed in the SQL or optional metadata.
- It can miss subtle semantic changes.
- It can produce warnings for intentional changes.
- The GitHub Actions support is currently a preview that prints output in CI logs.
- It does not post real GitHub PR comments yet.

That tradeoff is intentional for now. The project is trying to find the useful middle ground between raw text diffs and a heavy metric governance system.

## What Feedback Is Needed

I am looking for feedback from people who review or maintain analytics SQL, dbt models, BI datasets, KPI definitions, or product/finance dashboards.

The most useful feedback would be:

- Real SQL changes that caused metric confusion.
- Risk cases that should be detected before anything else.
- Cases where this kind of heuristic warning would be too noisy.
- Whether the Verdict + Impact style is useful for review.
- Whether optional CI gating makes sense for analytics workflows.
- What metadata, config, or annotations would make the tool more accurate without making it heavy.

The project is intentionally early. The next step is to learn which semantic changes data teams actually care about catching.
