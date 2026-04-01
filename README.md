# semantic-delta-detector

A small CLI tool that compares two SQL queries and highlights semantic differences in business meaning.

This MVP is intentionally simple:

- no full SQL AST
- no performance analysis
- no syntax linting
- yes to business-logic comparison

## What it does

Given two SQL queries or metric-definition inputs, the tool:

- extracts tables, filters, conditions, time windows, and aggregation
- compares those elements
- infers likely business meaning with lightweight heuristics
- optionally compares metric metadata such as name, description, team context, and intended use
- estimates a semantic similarity score
- assigns a confidence level based on available evidence
- outputs both human-readable text and structured JSON

## Project structure

```text
src/
  cli.ts
  types.ts
  parser/sqlTokenizer.ts
  analyzer/differenceEngine.ts
  analyzer/semanticHeuristics.ts
  output/formatReport.ts
  examples/queryPairs.ts
```

## Install

```bash
pnpm install
```

## Run

Compare inline queries:

```bash
pnpm compare --query-a "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'" --query-b "SELECT COUNT(DISTINCT user_id) FROM users WHERE subscription_status = 'paid'"
```

Compare SQL files:

```bash
pnpm compare --file-a ./query-a.sql --file-b ./query-b.sql
```

Compare JSON metric definitions:

```bash
pnpm compare --json-a ./src/examples/product-active-users.json --json-b ./src/examples/finance-active-users.json
```

Run a bundled example:

```bash
pnpm example
```

Run demo mode:

```bash
pnpm compare --example login-vs-paid --demo
```

Run bundled example SQL files directly:

```bash
pnpm compare --file-a ./src/examples/login-users.sql --file-b ./src/examples/paid-users.sql
```

Get JSON only:

```bash
pnpm compare --example login-vs-paid --format json
```

Demo mode is designed for fast product walkthroughs. It leads with the verdict, explains what each query actually measures, highlights the top semantic conflicts, and ends with a business-facing recommendation.

If metadata is missing, the tool still runs. It will simply lower confidence and say that the warning is based mostly on SQL evidence.

Run the lightweight test suite:

```bash
pnpm test
```

## Output shape

```json
{
  "metric_name_a": "...",
  "metric_name_b": "...",
  "semantic_similarity_score": 0,
  "detected_differences": [],
  "likely_business_meaning_a": "...",
  "likely_business_meaning_b": "...",
  "risk_level": "low | medium | high",
  "confidence_level": "low | medium | high",
  "evidence_sources": [
    "sql_only | sql | metric_name | description | team_context | intended_use"
  ],
  "explanation": "...",
  "recommendation": "..."
}
```

## Example

Query A:

```sql
SELECT COUNT(DISTINCT user_id)
FROM events
WHERE event = 'login'
AND event_date >= CURRENT_DATE - INTERVAL '30 days'
```

Query B:

```sql
SELECT COUNT(DISTINCT user_id)
FROM users
WHERE subscription_status = 'paid'
AND last_active >= CURRENT_DATE - INTERVAL '30 days'
```

Typical semantic interpretation:

- Query A: engaged users
- Query B: paying users
- semantic difference: high

Typical reasoning:

- same broad entity space: users
- different business meaning: engagement vs monetization
- same 30-day horizon, but different time basis: `event_date` vs `last_active`
- recommendation: treat as separate metrics, not one interchangeable KPI

Metadata-aware reasoning can strengthen the warning:

- same metric name: `active_users`
- different descriptions: login-based vs paying recently active users
- different team contexts: product vs finance
- different intended uses: dashboard vs executive revenue reporting
- higher confidence because both SQL and metadata point to semantic divergence

## Notes on the approach

The parser is a tokenizer-style extractor, not a full SQL parser. That keeps the MVP small and readable while still surfacing common business-definition drift:

- different source tables
- different inclusion filters
- different date logic
- different aggregation logic
- different likely business intent

This makes it useful as a first-pass review tool for analysts and engineers who want to sanity-check whether two metrics actually mean the same thing.

## Limitations

- SQL dialect coverage is intentionally shallow
- nested queries and complex joins are only partially understood
- heuristics are rule-based and not ML-driven
- similarity score is directional guidance, not ground truth

## Next steps

- improve parsing of grouped metrics and aliases
- detect join-level population changes
- support YAML or metric-definition inputs in addition to raw SQL
- add tests around representative metric pairs
