import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/postgresql.js";
import {
  NodeSqlPostgresqlParserAdapter,
  nodeSqlPostgresqlParser,
  postgresqlParserResourceLimits,
} from "../src/parser/nodeSqlParserAdapter.js";
import { getSetOperationBranches } from "../src/parser/sqlStructure.js";

const setOperators = ["UNION", "UNION ALL", "INTERSECT", "EXCEPT"] as const;

function buildLinearSetQuery(
  branchCount: number,
  operator: (typeof setOperators)[number],
  tableName = "users",
): string {
  return Array.from(
    { length: branchCount },
    () => `SELECT user_id FROM ${tableName}`,
  ).join(` ${operator} `);
}

function assertResourceFailure(
  result: ReturnType<typeof nodeSqlPostgresqlParser.parse>,
  pattern: RegExp,
): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, pattern);
  }
}

test("oversized SQL is rejected before the synchronous vendor parser runs", () => {
  let parserCalls = 0;
  const adapter = new NodeSqlPostgresqlParserAdapter({
    astify(): unknown {
      parserCalls += 1;
      return { type: "select", from: [] };
    },
  });
  const sql = "x".repeat(postgresqlParserResourceLimits.maxSqlCharacters + 1);

  assertResourceFailure(adapter.parse(sql), /SQL input.*resource limit/i);
  assert.equal(parserCalls, 0);
});

test("an oversized query keeps fallback semantic risk visible", () => {
  const padding = "x".repeat(postgresqlParserResourceLimits.maxSqlCharacters);
  const result = compareSqlQueries(
    `SELECT COUNT(*) FROM users /* ${padding} */`,
    `SELECT COUNT(*) FROM payments /* ${padding} */`,
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "low");
  assert.match(
    result.parser_limitations?.join(" ") ?? "",
    /SQL input.*resource limit/i,
  );
});

test("a deeply nested vendor AST fails closed at the traversal depth budget", () => {
  let nested: unknown = { value: 1 };
  for (
    let depth = 0;
    depth <= postgresqlParserResourceLimits.maxAstDepth;
    depth += 1
  ) {
    nested = { child: nested };
  }
  const adapter = new NodeSqlPostgresqlParserAdapter({
    astify: () => ({ type: "select", from: [], nested }),
  });

  assertResourceFailure(adapter.parse("SELECT 1"), /AST depth.*resource limit/i);
});

test("deeply nested non-set-operation SQL remains protected by the AST depth budget", () => {
  const sql = `SELECT user_id FROM users WHERE ${"NOT (".repeat(70)}is_active = true${")".repeat(70)}`;

  assertResourceFailure(
    nodeSqlPostgresqlParser.parse(sql),
    /vendor AST depth exceeds.*64/i,
  );
});

test("set-operation depth handling does not exempt a deeply nested branch", () => {
  const shallowBranches = buildLinearSetQuery(63, "UNION ALL");
  const deepBranch = `SELECT user_id FROM users WHERE ${"NOT (".repeat(70)}is_active = true${")".repeat(70)}`;

  assertResourceFailure(
    nodeSqlPostgresqlParser.parse(`${shallowBranches} UNION ALL ${deepBranch}`),
    /vendor AST depth exceeds.*64/i,
  );
});

test("a vendor AST with too many nodes fails closed", () => {
  const groups = Array.from({ length: 20 }, () =>
    Array.from(
      {
        length:
          Math.floor(postgresqlParserResourceLimits.maxAstNodes / 20) + 1,
      },
      () => ({ value: 1 }),
    ),
  );
  const adapter = new NodeSqlPostgresqlParserAdapter({
    astify: () => ({ type: "select", from: [], groups }),
  });

  assertResourceFailure(adapter.parse("SELECT 1"), /AST node.*resource limit/i);
});

test("a shared AST array cannot terminate full-tree depth validation early", () => {
  const shared: unknown[] = [];
  let deepLocation: unknown = { value: 1 };
  for (
    let depth = 0;
    depth <= postgresqlParserResourceLimits.maxAstDepth;
    depth += 1
  ) {
    deepLocation = { child: deepLocation };
  }
  const adapter = new NodeSqlPostgresqlParserAdapter({
    astify: () => ({
      type: "select",
      from: [],
      loc: deepLocation,
      sharedFirst: shared,
      sharedSecond: shared,
    }),
  });

  assertResourceFailure(adapter.parse("SELECT 1"), /AST depth.*resource limit/i);
});

test("a pathological vendor list fails closed", () => {
  const adapter = new NodeSqlPostgresqlParserAdapter({
    astify: () => ({
      type: "select",
      from: [],
      columns: Array.from(
        { length: postgresqlParserResourceLimits.maxListItems + 1 },
        () => 1,
      ),
    }),
  });

  assertResourceFailure(adapter.parse("SELECT 1"), /AST list.*resource limit/i);
});

test("large UNION chains degrade through a visible parser limitation", () => {
  const sql = Array.from(
    { length: postgresqlParserResourceLimits.maxSetOperationBranches + 1 },
    (_, index) => `SELECT user_id FROM users_${index}`,
  ).join(" UNION ALL ");
  const result = compareSqlQueries(sql, sql);

  assert.equal(result.risk_level, "low");
  assert.equal(result.confidence_level, "low");
  assert.match(
    result.parser_limitations?.join(" ") ?? "",
    /resource limit/i,
  );
});

for (const operator of setOperators) {
  test(`${operator} accepts the documented maximum set-operation branch count`, () => {
    const result = nodeSqlPostgresqlParser.parse(
      buildLinearSetQuery(
        postgresqlParserResourceLimits.maxSetOperationBranches,
        operator,
      ),
    );

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (result.ok) {
      assert.notEqual(result.syntax.setExpression, null);
      assert.equal(
        getSetOperationBranches(result.syntax.setExpression!).length,
        postgresqlParserResourceLimits.maxSetOperationBranches,
      );
    }
  });

  test(`${operator} rejects exactly one branch above the documented maximum`, () => {
    const result = nodeSqlPostgresqlParser.parse(
      buildLinearSetQuery(
        postgresqlParserResourceLimits.maxSetOperationBranches + 1,
        operator,
      ),
    );

    assertResourceFailure(result, /set-operation branch count exceeds.*64/i);
  });
}

test("set-operation branch overflow preserves fallback risk and limits confidence", () => {
  const branchCount = postgresqlParserResourceLimits.maxSetOperationBranches + 1;
  const result = compareSqlQueries(
    buildLinearSetQuery(branchCount, "UNION ALL", "users"),
    buildLinearSetQuery(branchCount, "UNION ALL", "payments"),
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "low");
  assert.match(
    result.parser_limitations?.join(" ") ?? "",
    /set-operation branch count exceeds.*64/i,
  );
});

test("too many window expressions fail closed", () => {
  const expressions = Array.from(
    { length: postgresqlParserResourceLimits.maxWindowExpressions + 1 },
    (_, index) => `ROW_NUMBER() OVER (ORDER BY created_at) AS rank_${index}`,
  );
  const result = nodeSqlPostgresqlParser.parse(
    `SELECT ${expressions.join(", ")} FROM events`,
  );

  assertResourceFailure(result, /window expression.*resource limit/i);
});

test("very large self-join graphs fail closed", () => {
  const joins = Array.from(
    { length: postgresqlParserResourceLimits.maxSourceOccurrences },
    (_, index) =>
      `JOIN users user_${index + 1} ON user_${index}.manager_id = user_${index + 1}.id`,
  );
  const result = nodeSqlPostgresqlParser.parse(
    `SELECT user_0.id FROM users user_0 ${joins.join(" ")}`,
  );

  assertResourceFailure(result, /source occurrence.*resource limit/i);
});

test("unexpected vendor AST shapes fail closed instead of producing empty IR", () => {
  const adapter = new NodeSqlPostgresqlParserAdapter({
    astify: () => ({ type: "select", from: { unexpected: true } }),
  });

  const result = adapter.parse("SELECT 1");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /unsupported FROM shape/i);
  }
});
