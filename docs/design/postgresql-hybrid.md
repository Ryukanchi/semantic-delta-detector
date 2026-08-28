# PostgreSQL hybrid analysis boundary

The opt-in `semantic-delta-detector/postgresql` entrypoint adds syntax coverage
without replacing Semantic Delta's parser or semantic model:

```text
SQL
  -> node-sql-parser PostgreSQL frontend
  -> isolated adapter
  -> Semantic Delta SqlSyntaxSummary IR
  -> existing semantic heuristics and Difference Engine
```

Vendor AST objects and types remain inside `nodeSqlParserAdapter.ts`. The root
entrypoint and the browser-safe `semantic-delta-detector/core` entrypoint do not
load `node-sql-parser`.

## Fail-closed behavior

If the vendor parser rejects a query, the adapter encounters an unsupported AST
shape, or a resource budget is exceeded, the enhanced entrypoint keeps the
lightweight Semantic Delta result. It also adds an explicit analysis limitation
and caps confidence at `low`. The cap does not lower semantic risk found by the
fallback analyzer.

Ambiguous or incomplete self-join role graphs follow the same conservative
policy. Semantic Delta does not guess a graph mapping.

## Resource budgets

The adapter currently enforces these limits:

| Resource | Limit |
| --- | ---: |
| SQL input | 256,000 characters |
| Vendor AST depth | 64 levels |
| Vendor AST nodes | 20,000 |
| One AST list/object | 4,096 items/properties |
| Set-operation branches | 64 |
| Window expressions | 256 |
| Source occurrences | 512 |
| Join edges | 1,024 |
| Qualified source usages | 4,096 |

The complete vendor AST is validated before Semantic Delta traverses it. The
specialized set-operation, window, join-graph, and source-usage collectors also
enforce their own output budgets.

## Synchronous parser limitation

`node-sql-parser` parses synchronously in the current architecture. The input
limit reduces exposure, but the adapter cannot enforce a hard wall-clock parse
timeout or interrupt a pathological parse already in progress. A real hard
timeout would require moving vendor parsing behind a Worker or separate process.
Semantic Delta deliberately does not claim timeout protection until that
isolation exists.
