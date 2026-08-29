import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/core.js";

test("a change in the second aggregation remains visible", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(DISTINCT user_id), SUM(revenue) FROM events",
    "SELECT COUNT(DISTINCT user_id), SUM(cost) FROM events",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        /SUM\(revenue\)/i.test(difference.description) &&
        /SUM\(cost\)/i.test(difference.description),
    ),
  );
});

test("all three aggregations participate in comparison", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*), SUM(revenue), AVG(order_value) FROM orders",
    "SELECT COUNT(*), SUM(revenue), MAX(order_value) FROM orders",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        /AVG\(order_value\)/i.test(difference.description) &&
        /MAX\(order_value\)/i.test(difference.description),
    ),
  );
});

test("reordering the same aggregation set is equivalent", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT user_id) AS users, SUM(revenue) AS revenue
     FROM events`,
    `SELECT SUM(revenue) AS revenue, COUNT(DISTINCT user_id) AS users
     FROM events`,
  );

  assert.equal(result.risk_level, "low");
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "aggregation_mismatch",
    ),
  );
});

test("changing one aggregation remains visible when another stays equal", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(DISTINCT user_id), SUM(revenue) FROM events",
    "SELECT COUNT(*), SUM(revenue) FROM events",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        /COUNT\(DISTINCT user_id\)/i.test(difference.description) &&
        /COUNT\(\*\)/i.test(difference.description),
    ),
  );
});

test("reordering the same GROUP BY set is equivalent", () => {
  const result = compareSqlQueries(
    `SELECT country, plan, COUNT(*)
     FROM users
     GROUP BY country, plan`,
    `SELECT country, plan, COUNT(*)
     FROM users
     GROUP BY plan, country`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});
