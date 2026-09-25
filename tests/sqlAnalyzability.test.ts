import assert from "node:assert/strict";
import test from "node:test";
import * as root from "../src/index.js";
import * as core from "../src/core.js";
import * as postgresql from "../src/postgresql.js";
import {
  assessSqlAnalyzability,
  UNANALYZABLE_SQL_CODE,
  type SqlAnalyzabilityReason,
} from "../src/analyzer/sqlAnalyzability.js";
import { comparePostgresqlMetricDefinitionsIsolated } from "../src/internal/enhancedSqlComparisonRuntime.js";
import { nodeSqlPostgresqlParser } from "../src/parser/nodeSqlParserAdapter.js";

function checkError(error: unknown, query: "A" | "B", reason: SqlAnalyzabilityReason): boolean {
  assert.ok(error instanceof Error);
  const contract = error as Error & { code?: string; query?: string; reason?: string };
  assert.equal(contract.code, UNANALYZABLE_SQL_CODE);
  assert.equal(contract.query, query);
  assert.equal(contract.reason, reason);
  assert.doesNotMatch(contract.message, /invalid SQL/i);
  return true;
}

const rejectedSql: ReadonlyArray<[string, SqlAnalyzabilityReason]> = [
  ["", "empty"],
  [" ; ; -- no query", "empty"],
  ["/* no query */", "empty"],
  ["hello world", "not_a_select_query"],
  ["banana", "not_a_select_query"],
  ["SELECT", "no_query_structure"],
  ["SELECT FROM", "no_query_structure"],
  ["SELECT FROM WHERE;", "no_query_structure"],
  ["SELECT FROM JOIN", "no_query_structure"],
  ["SELECT FROM ON", "no_query_structure"],
  ["SELECT FROM AS", "no_query_structure"],
  ["SELECT DISTINCT", "no_query_structure"],
  ["SELECT DISTINCT ON", "no_query_structure"],
  ["SELECT DISTINCT ON (", "no_query_structure"],
  ["SELECT TOP 1 WITH TIES", "no_query_structure"],
  ["WITH a AS (SELECT 1)", "no_query_structure"],
  ["INSERT INTO x SELECT 1", "not_a_select_query"],
  ["UPDATE users SET active = true", "not_a_select_query"],
  ["DELETE FROM users", "not_a_select_query"],
  ["MERGE INTO users USING next_users ON users.id = next_users.id", "not_a_select_query"],
  ["CREATE TABLE users (id integer)", "not_a_select_query"],
  ["VALUES (1)", "not_a_select_query"],
  ["TABLE users", "not_a_select_query"],
  ["EXPLAIN SELECT 1", "not_a_select_query"],
  ["WITH a AS (SELECT 1) INSERT INTO x SELECT * FROM a", "not_a_select_query"],
  ["SELECT 1; SELECT 2;", "multiple_statements"],
  ["SELECT 1; DELETE FROM users;", "multiple_statements"],
];

test("the dependency-free assessment classifies missing evidence and out-of-scope statements", () => {
  for (const [sql, reason] of rejectedSql) {
    assert.equal(assessSqlAnalyzability(sql).ok, false, sql);
    assert.deepEqual(assessSqlAnalyzability(sql).reason, reason, sql);
  }
});

test("root, core, and PostgreSQL sync routes share the coded input boundary", () => {
  for (const api of [root, core, postgresql]) {
    for (const [sql, reason] of rejectedSql) {
      assert.throws(() => api.compareSqlQueries(sql, "SELECT 1"), (error) =>
        checkError(error, "A", reason), sql);
      assert.throws(() => api.compareSqlQueries("SELECT 1", sql), (error) =>
        checkError(error, "B", reason), sql);
    }
    assert.throws(() => api.compareSqlQueries("banana", "hello world"), (error) =>
      checkError(error, "A", "not_a_select_query"));
    assert.throws(
      () => api.compareMetricDefinitions(
        { query: "hello world", description: "Metadata cannot replace SQL evidence" },
        { query: "SELECT 1", metric_name: "A metric" },
      ),
      (error) => checkError(error, "A", "not_a_select_query"),
    );
  }
});

test("the isolated PostgreSQL route rejects before it starts a worker", async () => {
  let workersStarted = 0;
  const harness = {
    workerFactory(): never {
      workersStarted += 1;
      throw new Error("worker must not start for unanalyzable SQL");
    },
  };
  for (const [sql, reason] of rejectedSql) {
    await assert.rejects(
      comparePostgresqlMetricDefinitionsIsolated({ query: sql }, { query: "SELECT 1" }, {}, harness),
      (error) => checkError(error, "A", reason),
      sql,
    );
    await assert.rejects(
      comparePostgresqlMetricDefinitionsIsolated({ query: "SELECT 1" }, { query: sql }, {}, harness),
      (error) => checkError(error, "B", reason),
      sql,
    );
    await assert.rejects(
      postgresql.compareSqlQueriesIsolated("SELECT 1", sql),
      (error) => checkError(error, "B", reason),
      sql,
    );
  }
  await assert.rejects(
    postgresql.compareSqlQueriesIsolated("banana", "hello world"),
    (error) => checkError(error, "A", "not_a_select_query"),
  );
  assert.equal(workersStarted, 0);
});

test("root, core, PostgreSQL sync, and isolated routes retain supported SELECT results", async () => {
  const acceptedSql = [
    "SELECT 1;",
    "SELECT FROM users WHERE active",
    "SELECT ';' AS x FROM t",
    "SELECT '{# literal #}' AS x FROM t",
  ];
  for (const sql of acceptedSql) {
    for (const api of [root, core, postgresql]) {
      assert.equal(api.compareSqlQueries(sql, sql).risk_level, "low", sql);
    }
    assert.equal((await postgresql.compareSqlQueriesIsolated(sql, sql)).risk_level, "low", sql);
  }
});

test("one supported SELECT expression survives protected semicolons and query modifiers", () => {
  const acceptedSql = [
    "SELECT 1",
    "SELECT 1;",
    "SELECT 1;;",
    "SELECT id FROM users",
    "SELECT FROM users WHERE active",
    "SELECT ';' AS x FROM t",
    "SELECT $$a;b$$ FROM t",
    "SELECT $tag$a;b$tag$ FROM t",
    'SELECT "a;b" FROM t',
    "SELECT [a;b] FROM t",
    "SELECT 1 -- ; inside a comment\n",
    "/* ; inside a comment */ SELECT 1",
    "\uFEFF -- header\nSELECT 1",
    "WITH RECURSIVE a AS (SELECT 1) SELECT * FROM a",
    "SELECT id FROM users UNION SELECT id FROM archived_users",
    "SELECT id FROM users INTERSECT SELECT id FROM active_users",
    "SELECT id FROM users EXCEPT SELECT id FROM deleted_users",
    "SELECT DISTINCT ON (id) id FROM users",
    "SELECT TOP 1 WITH TIES id FROM users",
    "{{ config(materialized='table') }}\nSELECT id FROM users",
    "{% set threshold = '1;2' %}\n{# ; ignored #}\nSELECT id FROM users",
  ];
  for (const sql of acceptedSql) {
    assert.deepEqual(assessSqlAnalyzability(sql), { ok: true }, sql);
    assert.doesNotThrow(() => root.compareSqlQueries(sql, sql), sql);
  }
});

test("Jinja comments containing SQL keywords do not hijack the analyzed root", () => {
  const before = "SELECT id FROM users";
  const commentedSameQuery = "{# SELECT bogus #}\nSELECT id FROM users";
  const commentedChangedSource = "{# SELECT bogus #}\nSELECT id FROM payments";

  const same = root.compareSqlQueries(before, commentedSameQuery);
  assert.equal(same.risk_level, "low");
  assert.deepEqual(same.detected_differences, []);

  const changed = root.compareSqlQueries(before, commentedChangedSource);
  assert.equal(changed.risk_level, "high");
  assert.match(
    changed.detected_differences.map((finding) => finding.description).join(" "),
    /different source domains/i,
  );
});

test("vendor parser rejection remains an uncertainty limitation, never an input verdict", () => {
  const vendorRejectedSql = [
    "SELECT region, COUNT(*) FROM sales GROUP BY GROUPING SETS ((region), ())",
    "SELECT id FROM users FOR UPDATE",
    "SELECT x.id FROM users x JOIN LATERAL (SELECT 1 AS id) y ON true",
    "SELECT (address).city FROM users",
    "SELECT id FROM users QUALIFY ROW_NUMBER() OVER (PARTITION BY id) = 1",
    "SELECT [id] FROM [users]",
    "{{ config(materialized='table') }}\nSELECT id FROM users",
  ];
  for (const sql of vendorRejectedSql) {
    assert.equal(nodeSqlPostgresqlParser.parse(sql).ok, false, sql);
    const result = postgresql.compareSqlQueries(sql, sql);
    assert.equal(result.risk_level, "low", sql);
    assert.equal(result.confidence_level, "low", sql);
    assert.match(result.parser_limitations?.join(" ") ?? "", /enhanced PostgreSQL syntax parser/i, sql);
  }
});

test("PostgreSQL sync preflight does not invoke the vendor parser for missing evidence", () => {
  const originalParse = nodeSqlPostgresqlParser.parse;
  let parseCalls = 0;
  nodeSqlPostgresqlParser.parse = () => {
    parseCalls += 1;
    throw new Error("vendor parser must not run");
  };
  try {
    assert.throws(
      () => postgresql.compareSqlQueries("hello world", "SELECT 1"),
      (error) => checkError(error, "A", "not_a_select_query"),
    );
    assert.equal(parseCalls, 0);
  } finally {
    nodeSqlPostgresqlParser.parse = originalParse;
  }
});
