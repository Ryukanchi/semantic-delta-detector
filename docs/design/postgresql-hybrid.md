# PostgreSQL hybrid analysis boundary

The opt-in `semantic-delta-detector/postgresql` entrypoint adds syntax coverage
without replacing Semantic Delta's parser or semantic model:

```text
SQL
  -> node-sql-parser PostgreSQL frontend
  -> isolated vendor adapter
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

The AST depth budget limits genuine structural nesting inside each query branch.
It protects recursive expression collectors and bounds pathological nesting;
the total AST-node budget independently limits overall size. In
`node-sql-parser@5.4.0`, linear `UNION`, `UNION ALL`, `INTERSECT`, and `EXCEPT`
chains are represented as linked `SELECT._next` statements. These links are a
horizontal branch sequence, not nested SQL expressions, so the adapter traverses
them iteratively without adding AST depth. The separate branch collector also
runs iteratively: 64 branches are accepted, while branch 65 fails closed with an
explicit set-operation branch-limit reason.

The budgets still compose across distinct resource axes. For example, any one
of 64 set-operation branches can independently exceed the depth limit, and a
large collection of otherwise shallow branches can still exceed the global
node, source-occurrence, or SQL-length budget. Set-operation handling exempts
only the validated horizontal `_next` link; it does not relax the depth limit
inside a branch or increase any configured limit.

## Synchronous parser limitation

The existing PostgreSQL functions remain synchronous and source-compatible:

```ts
import { compareSqlQueries } from "semantic-delta-detector/postgresql";

const result = compareSqlQueries(queryA, queryB);
```

This compatibility path executes the synchronous vendor parser on the calling
thread. Its input, AST, and traversal budgets still apply, but it cannot enforce
a hard wall-clock timeout or interrupt a parse already in progress. Semantic
Delta does not claim timeout or hard memory protection for this API.

## Isolated asynchronous API

Node consumers that need a terminable vendor parse can use the additive API:

```ts
import { compareSqlQueriesIsolated } from "semantic-delta-detector/postgresql";

const result = await compareSqlQueriesIsolated(queryA, queryB, {
  timeoutMs: 2_000,
});
```

`compareMetricDefinitionsIsolated` provides the matching metadata-aware shape.
Both functions are available only from the opt-in `/postgresql` entrypoint. The
root and browser-safe `/core` entrypoints remain unchanged.

The isolated path uses this execution boundary:

```text
caller thread
  -> lightweight Semantic Delta fallback analysis
  -> one-shot PostgreSQL parser Worker
       -> parse Query A, then Query B
       -> enforce existing adapter/AST/traversal budgets
       -> serialize only Semantic Delta's SqlSyntaxSummary IR
  -> validate request identity and the complete returned IR shape
  -> terminate Worker and await termination
  -> existing semantic heuristics and Difference Engine
```

The default timeout is 2,000 ms and can be configured from 1 through 60,000 ms.
It is one wall-clock budget for Worker construction, both sequential vendor
parses, IR mapping, serialization, and return communication. It intentionally
does not include the caller-thread fallback analysis or Difference Engine.

When the deadline expires, the caller invokes `Worker.terminate()` and does not
resolve the comparison until termination completes. Worker crashes, unexpected
exits, startup failures, malformed messages, oversized responses, mismatched
request IDs, and invalid IR all use the same fail-closed product behavior:

- keep the lightweight fallback structures;
- add an explicit limitation for both queries;
- cap confidence at `low`;
- preserve any semantic risk found by the fallback analyzer.

An ordinary vendor parse error remains query-specific because the Worker can
return a valid failure result for one query and valid IR for the other.

### Why a Worker Thread

`node-sql-parser@5.4.0` is pure JavaScript and does not require an operating
system process boundary. A Worker Thread therefore provides the smallest useful
boundary in this package:

- synchronous vendor JavaScript runs outside the caller thread;
- the caller can terminate that execution independently;
- Node exposes per-Worker V8 heap and stack resource limits;
- Worker startup and in-process messaging are lighter than spawning a separate
  Node executable;
- the Worker can return Semantic Delta IR without exposing vendor AST types.

A child process would isolate the operating-system process more strongly, but
Node does not provide a portable hard RSS limit for child processes. It would
also require a larger signal, executable, and IPC lifecycle. For this pure-JS
parser and the current package, the Worker is the smaller defensible first
boundary.

### Memory guarantees and remaining limits

Each parser Worker is created with fixed V8 limits:

| Worker V8 resource | Limit |
| --- | ---: |
| Old generation heap | 128 MiB |
| Young generation heap | 32 MiB |
| Stack | 4 MiB |

These limits meaningfully bound the Worker's JavaScript heap and stack. They are
not an operating-system RSS/cgroup limit: ArrayBuffers, native allocations,
Node runtime overhead, and other process-wide resources are not all covered.
Worker Threads also share the host process, so catastrophic native or
process-wide exhaustion is a residual risk. Deployments requiring an OS-enforced
memory ceiling still need a separate process/container boundary around Semantic
Delta. The timeout also depends on the caller event loop being scheduled; an
unrelated caller-thread stall can delay the timeout callback.

### Lifecycle and concurrency

The implementation deliberately uses one Worker per comparison and no pool.
The same Worker parses both inputs sequentially under one deadline. This avoids
cross-request state, stale parser state, idle Workers, pool shutdown rules, and
request-multiplexing races. Success and every failure path remove listeners and
await Worker termination before resolving. Parallel comparisons receive
independent Workers and request IDs.

The tradeoff is cold-start cost on every isolated comparison. The synchronous
API remains available for trusted inputs where latency is more important than a
terminable parse. A pool should be considered only after production measurements
show that startup dominates and after safe eviction/replacement semantics are
specified.

## Packaging and deployment

The compiled Worker entrypoint is shipped under `dist/internal` because the
package allowlist includes the complete `dist` tree. It is a runtime artifact,
not a public package subpath: `package.json` exports only `.`, `./core`, and
`./postgresql`, so consumers cannot import the Worker, isolation runner, or test
harness directly.

The Worker resolves its adjacent compiled adapter using `import.meta.url`.
Deployments must therefore preserve the `dist/internal` and `dist/parser`
layout produced by the package. Bundlers or serverless packagers using the
isolated Node API must copy the Worker artifact rather than treating it as an
unused module. Browser bundles should use `/core`; that graph contains neither
the vendor parser nor `node:worker_threads`.
