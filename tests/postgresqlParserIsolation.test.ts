import assert from "node:assert/strict";
import test from "node:test";
import { Worker, type WorkerOptions } from "node:worker_threads";
import {
  compareSqlQueries,
  compareMetricDefinitionsIsolated,
  compareSqlQueriesIsolated,
} from "../src/postgresql.js";
import {
  comparePostgresqlMetricDefinitionsIsolated,
} from "../src/internal/enhancedSqlComparisonRuntime.js";
import {
  postgresqlParserIsolationDefaults,
  runIsolatedPostgresqlParser,
  type PostgresqlParserIsolationHarness,
} from "../src/internal/postgresqlParserIsolation.js";
import { postgresqlParserResourceLimits } from "../src/parser/nodeSqlParserAdapter.js";

type HarnessMode = "hang" | "exit" | "crash" | "invalid-json" | "invalid-result";

function createHarness(
  mode: HarnessMode,
  lifecycle?: { created: number[]; terminated: number[] },
): PostgresqlParserIsolationHarness {
  return {
    workerFactory(_workerUrl: URL, options: WorkerOptions): Worker {
      return new Worker(
        `
          const { parentPort, workerData } = require("node:worker_threads");
          parentPort.once("message", (request) => {
            if (workerData.mode === "hang") {
              setInterval(() => {}, 1_000);
              return;
            }
            if (workerData.mode === "exit") {
              process.exit(17);
            }
            if (workerData.mode === "crash") {
              throw new Error("deterministic worker crash");
            }
            if (workerData.mode === "invalid-json") {
              parentPort.postMessage("not-json");
              return;
            }
            parentPort.postMessage(JSON.stringify({
              type: "postgresql_parse_pair_result",
              requestId: request.requestId,
              results: [{ ok: true, syntax: {} }],
            }));
          });
        `,
        {
          eval: true,
          resourceLimits: options.resourceLimits,
          workerData: { mode },
        },
      );
    },
    onWorkerCreated(threadId): void {
      lifecycle?.created.push(threadId);
    },
    onWorkerTerminated(threadId): void {
      lifecycle?.terminated.push(threadId);
    },
  };
}

test("the isolated API parses PostgreSQL successfully without changing semantic output", async () => {
  const queryA = "SELECT COUNT(DISTINCT user_id) FROM users";
  const queryB = "SELECT COUNT(DISTINCT user_id) FROM purchases";
  const result = await compareSqlQueriesIsolated(
    queryA,
    queryB,
  );

  assert.deepEqual(result, compareSqlQueries(queryA, queryB));
  assert.equal(result.risk_level, "high");
  assert.match(
    result.detected_differences.map((difference) => difference.description).join(" "),
    /different source domains/i,
  );
  assert.equal(result.parser_limitations, undefined);
});

test("vendor parse failures stay visible through the isolated API", async () => {
  const result = await compareSqlQueriesIsolated(
    "SELECT FROM WHERE;",
    "SELECT FROM WHERE;",
  );

  assert.equal(result.confidence_level, "low");
  assert.equal(result.parser_limitations?.length, 2);
  assert.match(result.parser_limitations?.[0] ?? "", /Query A could not be analyzed/i);
  assert.match(result.parser_limitations?.[1] ?? "", /Query B could not be analyzed/i);
});

test("a real wall-clock timeout terminates the worker before returning", async () => {
  const lifecycle = { created: [] as number[], terminated: [] as number[] };
  const startedAt = Date.now();
  const result = await runIsolatedPostgresqlParser(
    ["SELECT 1", "SELECT 1"],
    { timeoutMs: 25 },
    createHarness("hang", lifecycle),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "timeout");
    assert.match(result.reason, /timed out after 25 ms/i);
  }
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 15);
  assert.ok(elapsedMs < 2_000);
  assert.equal(lifecycle.created.length, 1);
  assert.deepEqual(lifecycle.terminated, lifecycle.created);
});

test("timeout fallback preserves semantic risk and caps confidence", async () => {
  const result = await comparePostgresqlMetricDefinitionsIsolated(
    {
      query: "DELETE FROM users;",
      description: "User population",
    },
    {
      query: "DELETE FROM payments;",
      description: "Payment population",
    },
    { timeoutMs: 25 },
    createHarness("hang"),
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "low");
  assert.match(result.parser_limitations?.join(" ") ?? "", /timed out after 25 ms/i);
});

test("an unexpected worker exit fails closed and is cleaned up", async () => {
  const lifecycle = { created: [] as number[], terminated: [] as number[] };
  const result = await runIsolatedPostgresqlParser(
    ["SELECT 1", "SELECT 1"],
    { timeoutMs: 1_000 },
    createHarness("exit", lifecycle),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "unexpected_exit");
    assert.match(result.reason, /code 17/i);
  }
  assert.deepEqual(lifecycle.terminated, lifecycle.created);
});

test("a worker crash fails closed without leaking its internal stack", async () => {
  const result = await runIsolatedPostgresqlParser(
    ["SELECT 1", "SELECT 1"],
    { timeoutMs: 1_000 },
    createHarness("crash"),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "worker_error");
    assert.match(result.reason, /deterministic worker crash/i);
    assert.doesNotMatch(result.reason, /postgresqlParserIsolation\.test/i);
  }
});

test("a Worker startup failure is returned as an isolation limitation", async () => {
  const result = await runIsolatedPostgresqlParser(
    ["SELECT 1", "SELECT 1"],
    { timeoutMs: 1_000 },
    {
      workerFactory(): Worker {
        throw new Error("deterministic startup failure");
      },
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "startup_error");
    assert.match(result.reason, /deterministic startup failure/i);
  }
});

test("invalid worker JSON is a visible communication failure", async () => {
  const result = await runIsolatedPostgresqlParser(
    ["SELECT 1", "SELECT 1"],
    { timeoutMs: 1_000 },
    createHarness("invalid-json"),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "protocol_error");
    assert.match(result.reason, /valid JSON/i);
  }
});

test("structurally invalid worker results fail deserialization closed", async () => {
  const result = await runIsolatedPostgresqlParser(
    ["SELECT 1", "SELECT 1"],
    { timeoutMs: 1_000 },
    createHarness("invalid-result"),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "protocol_error");
    assert.match(result.reason, /invalid parser result/i);
  }
});

test("oversized SQL is still rejected by the pre-parse resource limit", async () => {
  const padding = "x".repeat(postgresqlParserResourceLimits.maxSqlCharacters);
  const result = await compareSqlQueriesIsolated(
    `SELECT COUNT(*) FROM users /* ${padding} */`,
    `SELECT COUNT(*) FROM payments /* ${padding} */`,
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "low");
  assert.match(result.parser_limitations?.join(" ") ?? "", /SQL input.*resource limit/i);
});

test("set-operation branch overflow remains visible inside the worker", async () => {
  const sql = Array.from(
    { length: postgresqlParserResourceLimits.maxSetOperationBranches + 1 },
    (_, index) => `SELECT user_id FROM users_${index}`,
  ).join(" UNION ALL ");
  const result = await compareSqlQueriesIsolated(sql, sql);

  assert.equal(result.risk_level, "low");
  assert.equal(result.confidence_level, "low");
  assert.match(
    result.parser_limitations?.join(" ") ?? "",
    /set-operation branch count exceeds.*64/i,
  );
});

test("the documented 64-branch UNION limit survives Worker transfer", async () => {
  const sql = Array.from(
    { length: postgresqlParserResourceLimits.maxSetOperationBranches },
    (_, index) => `SELECT user_id FROM users_${index}`,
  ).join(" UNION ALL ");
  const result = await compareSqlQueriesIsolated(sql, sql);

  assert.equal(result.risk_level, "low");
  assert.equal(result.parser_limitations, undefined);
});

test("multiple sequential isolated comparisons use fresh workers and clean each one", async () => {
  const results = [];
  for (let index = 0; index < 3; index += 1) {
    results.push(
      await compareSqlQueriesIsolated(
        "SELECT COUNT(*) FROM users",
        "SELECT COUNT(*) FROM users",
      ),
    );
  }

  assert.deepEqual(results.map((result) => result.risk_level), ["low", "low", "low"]);
  assert.ok(results.every((result) => result.parser_limitations === undefined));
});

test("parallel isolated comparisons do not share requests or race cleanup", async () => {
  const results = await Promise.all([
    compareSqlQueriesIsolated("SELECT COUNT(*) FROM users", "SELECT COUNT(*) FROM users"),
    compareSqlQueriesIsolated("SELECT COUNT(*) FROM users", "SELECT COUNT(*) FROM orders"),
    compareSqlQueriesIsolated("SELECT COUNT(*) FROM events", "SELECT COUNT(*) FROM events"),
  ]);

  assert.deepEqual(results.map((result) => result.risk_level), ["low", "high", "low"]);
});

test("successful workers are terminated before the isolation promise resolves", async () => {
  const lifecycle = { created: [] as number[], terminated: [] as number[] };
  const result = await runIsolatedPostgresqlParser(
    ["SELECT COUNT(*) FROM users", "SELECT COUNT(*) FROM users"],
    { timeoutMs: postgresqlParserIsolationDefaults.timeoutMs },
    {
      onWorkerCreated(threadId): void {
        lifecycle.created.push(threadId);
      },
      onWorkerTerminated(threadId): void {
        lifecycle.terminated.push(threadId);
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(lifecycle.terminated, lifecycle.created);
});

test("metric metadata is supported by the additive isolated API", async () => {
  const result = await compareMetricDefinitionsIsolated(
    { query: "SELECT COUNT(*) FROM users", metric_name: "Users" },
    { query: "SELECT COUNT(*) FROM users", metric_name: "Users" },
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.metric_name_a, "Users");
});

test("the public options object cannot inject a Worker implementation", async () => {
  let injectedFactoryCalls = 0;
  const options = {
    timeoutMs: 1_000,
    workerFactory(): never {
      injectedFactoryCalls += 1;
      throw new Error("public Worker injection must not run");
    },
  };

  const result = await compareSqlQueriesIsolated(
    "SELECT COUNT(*) FROM users",
    "SELECT COUNT(*) FROM users",
    options,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(injectedFactoryCalls, 0);
});

test("invalid public timeout values reject before starting vendor work", async () => {
  await assert.rejects(
    compareSqlQueriesIsolated(
      "SELECT COUNT(*) FROM users",
      "SELECT COUNT(*) FROM users",
      { timeoutMs: 0 },
    ),
    /timeoutMs must be an integer from 1 to 60000/i,
  );
});
