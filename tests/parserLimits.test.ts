import test from "node:test";
import assert from "node:assert/strict";
import { compareSqlQueries } from "../src/analyzer/differenceEngine.js";
import { detectUnsupportedSqlConstructs } from "../src/parser/unsupportedConstructs.js";
import { formatReadableReport } from "../src/output/formatReport.js";
import { formatPrComment } from "../src/output/formatPrComment.js";

test("detector finds WITH/CTE, CASE, and subquery constructs", () => {
  assert.deepEqual(
    detectUnsupportedSqlConstructs(
      "WITH active AS (SELECT user_id FROM events) SELECT COUNT(*) FROM active",
    ).map((item) => item.construct),
    ["cte"],
  );
  assert.deepEqual(
    detectUnsupportedSqlConstructs(
      "SELECT COUNT(CASE WHEN is_paid THEN 1 END) FROM users",
    ).map((item) => item.construct),
    ["case_expression"],
  );
  assert.deepEqual(
    detectUnsupportedSqlConstructs(
      "SELECT COUNT(*) FROM (SELECT user_id FROM events) sub",
    ).map((item) => item.construct),
    ["derived_table_subquery"],
  );
  assert.deepEqual(
    detectUnsupportedSqlConstructs(
      "SELECT COUNT(*) FROM users WHERE id IN (SELECT user_id FROM orders)",
    ).map((item) => item.construct),
    ["in_subquery"],
  );
  assert.deepEqual(
    detectUnsupportedSqlConstructs(
      "SELECT COUNT(*) FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)",
    ).map((item) => item.construct),
    ["exists_subquery"],
  );
});

test("detector stays quiet for simple supported queries", () => {
  assert.deepEqual(
    detectUnsupportedSqlConstructs(
      "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login' AND event_date >= CURRENT_DATE - INTERVAL '7 days'",
    ),
    [],
  );
});

test("WITH query produces an explicit limited-confidence note in the result", () => {
  const withQuery =
    "WITH active AS (SELECT user_id FROM events) SELECT COUNT(*) FROM active";
  const result = compareSqlQueries(withQuery, withQuery);

  assert.ok(result.parser_limitations);
  assert.equal(result.parser_limitations.length, 2);
  assert.match(result.parser_limitations[0], /Query A/);
  assert.match(result.parser_limitations[0], /WITH\/CTE/);
  assert.match(result.parser_limitations[0], /confidence.*limited/i);
  assert.match(result.parser_limitations[1], /Query B/);
});

test("CASE expression produces an explicit limited-confidence note", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid",
    "SELECT COUNT(CASE WHEN is_paid THEN 1 END) FROM users",
  );

  assert.ok(result.parser_limitations);
  assert.equal(result.parser_limitations.length, 1);
  assert.match(result.parser_limitations[0], /Query B/);
  assert.match(result.parser_limitations[0], /CASE expression/);
  assert.match(result.parser_limitations[0], /confidence.*limited/i);
});

test("IN (SELECT ...) subquery produces an explicit limited-confidence note", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users",
    "SELECT COUNT(*) FROM users WHERE id IN (SELECT user_id FROM orders)",
  );

  assert.ok(result.parser_limitations);
  assert.match(result.parser_limitations[0], /IN \(SELECT \.\.\.\) subquery/);
});

test("simple queries do not produce a parser limitation note", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE country = 'DE'",
    "SELECT COUNT(*) FROM users WHERE country = 'US'",
  );

  assert.equal(result.parser_limitations, undefined);
});

test("parser limitation notes appear in the readable report output", () => {
  const withQuery =
    "WITH active AS (SELECT user_id FROM events) SELECT COUNT(*) FROM active";
  const result = compareSqlQueries(withQuery, withQuery);
  const report = formatReadableReport(result, withQuery, withQuery);

  assert.match(report, /## Analysis Limits/);
  assert.match(report, /WITH\/CTE/);
});

test("parser limitation notes appear in the PR-style output", () => {
  const withQuery =
    "WITH active AS (SELECT user_id FROM events) SELECT COUNT(*) FROM active";
  const result = compareSqlQueries(withQuery, withQuery);
  const comment = formatPrComment(result);

  assert.match(comment, /Note: Query A uses SQL constructs/);
});

test("simple query reports do not mention analysis limits", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE country = 'DE'",
    "SELECT COUNT(*) FROM users WHERE country = 'DE'",
  );

  assert.doesNotMatch(formatReadableReport(result), /Analysis Limits/);
  assert.doesNotMatch(formatPrComment(result), /Note: Query/);
});
