import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/postgresql.js";

function assertHighRiskWindowDifference(
  result: ReturnType<typeof compareSqlQueries>,
  descriptionPattern: RegExp,
): void {
  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "medium");
  assert.ok(result.semantic_similarity_score < 100);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        descriptionPattern.test(difference.description),
    ),
  );
}

test("a PARTITION BY change is a visible window semantic change", () => {
  const result = compareSqlQueries(
    `SELECT user_id,
            ROW_NUMBER() OVER (
              PARTITION BY country
              ORDER BY created_at
            ) AS row_position
     FROM users;`,
    `SELECT user_id,
            ROW_NUMBER() OVER (
              PARTITION BY plan
              ORDER BY created_at
            ) AS row_position
     FROM users;`,
  );

  assertHighRiskWindowDifference(
    result,
    /ROW_NUMBER.*PARTITION BY.*country.*plan/is,
  );
});

test("a window ORDER BY expression change is visible", () => {
  const result = compareSqlQueries(
    `SELECT user_id,
            ROW_NUMBER() OVER (
              PARTITION BY user_id
              ORDER BY created_at
            ) AS row_position
     FROM users;`,
    `SELECT user_id,
            ROW_NUMBER() OVER (
              PARTITION BY user_id
              ORDER BY updated_at
            ) AS row_position
     FROM users;`,
  );

  assertHighRiskWindowDifference(
    result,
    /ROW_NUMBER.*ORDER BY.*created_at.*updated_at/is,
  );
  assert.equal(
    result.detected_differences.some(
      (difference) => difference.category === "metric_intent_mismatch",
    ),
    false,
    "ORDER BY syntax must not masquerade as the commercial orders domain",
  );
});

test("a window ORDER BY direction change is visible", () => {
  const result = compareSqlQueries(
    `SELECT ROW_NUMBER() OVER (ORDER BY created_at ASC) AS row_position
     FROM users;`,
    `SELECT ROW_NUMBER() OVER (ORDER BY created_at DESC) AS row_position
     FROM users;`,
  );

  assertHighRiskWindowDifference(
    result,
    /ROW_NUMBER.*ORDER BY.*created_at ASC.*created_at DESC/is,
  );
});

test("a window NULLS ordering change is visible", () => {
  const result = compareSqlQueries(
    `SELECT ROW_NUMBER() OVER (
              ORDER BY created_at ASC NULLS FIRST
            ) AS row_position
     FROM users;`,
    `SELECT ROW_NUMBER() OVER (
              ORDER BY created_at ASC NULLS LAST
            ) AS row_position
     FROM users;`,
  );

  assertHighRiskWindowDifference(
    result,
    /ROW_NUMBER.*ORDER BY.*NULLS FIRST.*NULLS LAST/is,
  );
});

test("window ORDER BY key precedence remains significant", () => {
  const result = compareSqlQueries(
    `SELECT ROW_NUMBER() OVER (
              ORDER BY created_at, event_id
            ) AS row_position
     FROM events;`,
    `SELECT ROW_NUMBER() OVER (
              ORDER BY event_id, created_at
            ) AS row_position
     FROM events;`,
  );

  assertHighRiskWindowDifference(
    result,
    /ROW_NUMBER.*ORDER BY.*created_at.*event_id.*event_id.*created_at/is,
  );
});

test("a window frame boundary change is visible", () => {
  const result = compareSqlQueries(
    `SELECT SUM(amount) OVER (
              ORDER BY created_at
              ROWS BETWEEN 30 PRECEDING AND CURRENT ROW
            ) AS rolling_amount
     FROM payments;`,
    `SELECT SUM(amount) OVER (
              ORDER BY created_at
              ROWS BETWEEN 7 PRECEDING AND CURRENT ROW
            ) AS rolling_amount
     FROM payments;`,
  );

  assertHighRiskWindowDifference(
    result,
    /SUM.*frame.*ROWS BETWEEN 30 PRECEDING AND CURRENT ROW.*ROWS BETWEEN 7 PRECEDING AND CURRENT ROW/is,
  );
});

test("a window frame end-boundary change is visible", () => {
  const result = compareSqlQueries(
    `SELECT SUM(amount) OVER (
              ORDER BY created_at
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS rolling_amount
     FROM payments;`,
    `SELECT SUM(amount) OVER (
              ORDER BY created_at
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) AS rolling_amount
     FROM payments;`,
  );

  assertHighRiskWindowDifference(
    result,
    /SUM.*frame.*CURRENT ROW.*UNBOUNDED FOLLOWING/is,
  );
});

test("identical window specifications remain low risk", () => {
  const sql = `SELECT user_id,
                      ROW_NUMBER() OVER (
                        PARTITION BY country
                        ORDER BY created_at DESC
                      ) AS row_position
               FROM users;`;

  const result = compareSqlQueries(sql, sql);

  assert.equal(result.risk_level, "low");
  assert.equal(result.semantic_similarity_score, 100);
  assert.deepEqual(result.detected_differences, []);
});

test("partition-key order and implicit ASC are canonicalized as equivalent", () => {
  const result = compareSqlQueries(
    `SELECT ROW_NUMBER() OVER (
              PARTITION BY country, plan
              ORDER BY created_at
            ) AS row_position
     FROM users;`,
    `select row_number() over (
              partition by plan, country
              order by created_at asc nulls last
            ) as row_position
     from users;`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.semantic_similarity_score, 100);
  assert.deepEqual(result.detected_differences, []);
});

test("a change in a later window expression is not hidden by an unchanged first window", () => {
  const result = compareSqlQueries(
    `SELECT ROW_NUMBER() OVER (
              PARTITION BY country
              ORDER BY created_at
            ) AS row_position,
            SUM(amount) OVER (
              PARTITION BY user_id
              ORDER BY created_at
              ROWS BETWEEN 30 PRECEDING AND CURRENT ROW
            ) AS rolling_amount
     FROM payments;`,
    `SELECT ROW_NUMBER() OVER (
              PARTITION BY country
              ORDER BY created_at
            ) AS row_position,
            SUM(amount) OVER (
              PARTITION BY user_id
              ORDER BY created_at
              ROWS BETWEEN 7 PRECEDING AND CURRENT ROW
            ) AS rolling_amount
     FROM payments;`,
  );

  assertHighRiskWindowDifference(
    result,
    /SUM.*frame.*30 PRECEDING.*7 PRECEDING/is,
  );
});

test("adding a window expression is visible", () => {
  const result = compareSqlQueries(
    "SELECT user_id FROM users;",
    `SELECT user_id,
            ROW_NUMBER() OVER (ORDER BY created_at) AS row_position
     FROM users;`,
  );

  assertHighRiskWindowDifference(
    result,
    /window expression count changed from 0 to 1/i,
  );
});

test("changing the window function is visible", () => {
  const result = compareSqlQueries(
    `SELECT ROW_NUMBER() OVER (ORDER BY created_at) AS row_position
     FROM users;`,
    `SELECT RANK() OVER (ORDER BY created_at) AS row_position
     FROM users;`,
  );

  assertHighRiskWindowDifference(
    result,
    /window function changes from ROW_NUMBER to RANK/i,
  );
});

test("reordering identical window expressions remains equivalent", () => {
  const result = compareSqlQueries(
    `SELECT ROW_NUMBER() OVER (ORDER BY created_at) AS row_position,
            SUM(amount) OVER (
              ORDER BY created_at
              ROWS BETWEEN 30 PRECEDING AND CURRENT ROW
            ) AS rolling_amount
     FROM payments;`,
    `SELECT SUM(amount) OVER (
              ORDER BY created_at
              ROWS BETWEEN 30 PRECEDING AND CURRENT ROW
            ) AS rolling_amount,
            ROW_NUMBER() OVER (ORDER BY created_at) AS row_position
     FROM payments;`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.semantic_similarity_score, 100);
  assert.deepEqual(result.detected_differences, []);
});
