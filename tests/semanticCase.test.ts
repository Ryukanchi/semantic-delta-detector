import assert from "node:assert/strict";
import test from "node:test";
import { compareMetricDefinitions, compareSqlQueries } from "../src/core.js";

test("a CASE condition change is described as metric-definition logic", () => {
  const result = compareSqlQueries(
    "SELECT SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) FROM orders",
    "SELECT SUM(CASE WHEN status IN ('paid', 'refunded') THEN amount ELSE 0 END) FROM orders",
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "medium");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /CASE expression/i.test(difference.description) &&
        /condition/i.test(difference.description) &&
        /status = 'paid'/i.test(difference.description) &&
        /status in\('paid','refunded'\)/i.test(difference.description),
    ),
  );
});

test("a CASE result change remains visible inside SUM", () => {
  const result = compareSqlQueries(
    "SELECT SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) FROM orders",
    "SELECT SUM(CASE WHEN status = 'paid' THEN amount * 0.8 ELSE 0 END) FROM orders",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        /CASE expression/i.test(difference.description) &&
        /result/i.test(difference.description) &&
        /amount \* 0\.8/i.test(difference.description),
    ),
  );
});

test("a CASE ELSE change remains visible", () => {
  const result = compareSqlQueries(
    "SELECT SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) FROM orders",
    "SELECT SUM(CASE WHEN status = 'paid' THEN amount ELSE NULL END) FROM orders",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        /CASE expression/i.test(difference.description) &&
        /result/i.test(difference.description) &&
        /NULL/i.test(difference.description),
    ),
  );
});

test("CASE changes without an aggregation do not disappear", () => {
  const result = compareSqlQueries(
    "SELECT CASE WHEN active THEN 'active' ELSE 'inactive' END AS state FROM users",
    "SELECT CASE WHEN active THEN 'enabled' ELSE 'disabled' END AS state FROM users",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) => /CASE expression/i.test(difference.description),
    ),
  );
});

test("each CASE expression participates in comparison", () => {
  const result = compareSqlQueries(
    `SELECT
       CASE WHEN country = 'DE' THEN 1 ELSE 0 END AS german,
       CASE WHEN plan = 'pro' THEN 1 ELSE 0 END AS qualified
     FROM users`,
    `SELECT
       CASE WHEN country = 'DE' THEN 1 ELSE 0 END AS german,
       CASE WHEN plan IN ('pro', 'enterprise') THEN 1 ELSE 0 END AS qualified
     FROM users`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        /CASE expression #2/i.test(difference.description) &&
        /condition/i.test(difference.description),
    ),
  );
});

test("identical CASE definitions stay low risk with conservative confidence", () => {
  const sql = "SELECT SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) FROM orders";
  const result = compareSqlQueries(sql, sql);

  assert.equal(result.risk_level, "low");
  assert.equal(result.confidence_level, "low");
  assert.equal(result.detected_differences.length, 0);
  assert.ok(result.parser_limitations?.some((note) => /CASE expression/.test(note)));
});

test("CASE risk and confidence remain independent with metadata", () => {
  const result = compareMetricDefinitions(
    {
      query: "SELECT SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) FROM orders",
      metric_name: "recognized_revenue",
      description: "Recognized order revenue",
      team_context: "finance",
    },
    {
      query: "SELECT SUM(CASE WHEN status IN ('paid', 'refunded') THEN amount ELSE 0 END) FROM orders",
      metric_name: "recognized_revenue",
      description: "Recognized order revenue",
      team_context: "finance",
    },
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "medium");
});
