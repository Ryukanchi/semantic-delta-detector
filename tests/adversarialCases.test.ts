import test from "node:test";
import assert from "node:assert/strict";
import { compareSqlQueries } from "../src/analyzer/differenceEngine.js";

// Risk-level contract for changes that must never be waved through as low risk.
// Assertions here are structural (risk level, category) rather than prose-based,
// so they survive wording changes in the report layer.

test("adversarial: WHERE AND to OR must not be low risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid AND is_active",
    "SELECT COUNT(*) FROM users WHERE is_paid OR is_active",
  );

  assert.notEqual(result.risk_level, "low");
});

test("adversarial: LEFT JOIN to INNER JOIN remains high risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(user_id) FROM users LEFT JOIN orders ON users.id = orders.user_id",
    "SELECT COUNT(user_id) FROM users INNER JOIN orders ON users.id = orders.user_id",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "join_type_mismatch",
    ),
  );
});

test("adversarial: COUNT(DISTINCT user_id) to COUNT(*) remains high risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
    "SELECT COUNT(*) FROM events WHERE event = 'login'",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "aggregation_mismatch",
    ),
  );
});

test("adversarial: removing an exclusion filter is at least medium risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE status != 'deleted'",
    "SELECT COUNT(*) FROM users",
  );

  assert.ok(
    result.risk_level === "medium" || result.risk_level === "high",
    `expected at least medium risk, got ${result.risk_level}`,
  );
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "business_logic_mismatch",
    ),
  );
});

test("adversarial: formatting-only changes remain low risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE country = 'DE' AND is_active",
    `select count(*)
FROM users
WHERE country = 'DE'
  AND is_active`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});
