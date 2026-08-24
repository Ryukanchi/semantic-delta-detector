import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/core.js";

test("a filter change inside a referenced CTE remains visible", () => {
  const result = compareSqlQueries(
    `WITH active_users AS (
       SELECT user_id FROM events WHERE event_name = 'login'
     )
     SELECT COUNT(DISTINCT user_id) FROM active_users`,
    `WITH active_users AS (
       SELECT user_id FROM events WHERE event_name = 'purchase'
     )
     SELECT COUNT(DISTINCT user_id) FROM active_users`,
  );

  assert.notEqual(result.risk_level, "low");
  assert.equal(result.confidence_level, "medium");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /CTE active_users/i.test(difference.description) &&
        /event_name = 'login'/i.test(difference.description) &&
        /event_name = 'purchase'/i.test(difference.description),
    ),
  );
  assert.ok(result.parser_limitations?.some((note) => /WITH\/CTE/.test(note)));
});

test("a source-table change inside a referenced CTE is high risk", () => {
  const result = compareSqlQueries(
    `WITH active_users AS (SELECT user_id FROM events)
     SELECT COUNT(DISTINCT user_id) FROM active_users`,
    `WITH active_users AS (SELECT user_id FROM purchases)
     SELECT COUNT(DISTINCT user_id) FROM active_users`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "source_domain_mismatch" &&
        /CTE active_users/i.test(difference.description) &&
        /events/i.test(difference.description) &&
        /purchases/i.test(difference.description),
    ),
  );
});

test("nested CTE changes are followed through referenced scopes", () => {
  const result = compareSqlQueries(
    `WITH base AS (
       SELECT user_id FROM events WHERE event_name = 'login'
     ), active AS (
       SELECT user_id FROM base
     )
     SELECT COUNT(*) FROM active`,
    `WITH base AS (
       SELECT user_id FROM events WHERE event_name = 'purchase'
     ), active AS (
       SELECT user_id FROM base
     )
     SELECT COUNT(*) FROM active`,
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /CTE base/i.test(difference.description),
    ),
  );
});

test("a change in a second referenced CTE is not hidden by an unchanged first CTE", () => {
  const result = compareSqlQueries(
    `WITH countries AS (
       SELECT user_id FROM users WHERE country = 'DE'
     ), activity AS (
       SELECT user_id FROM events WHERE event_name = 'login'
     )
     SELECT COUNT(*) FROM countries JOIN activity USING (user_id)`,
    `WITH countries AS (
       SELECT user_id FROM users WHERE country = 'DE'
     ), activity AS (
       SELECT user_id FROM events WHERE event_name = 'purchase'
     )
     SELECT COUNT(*) FROM countries JOIN activity USING (user_id)`,
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /CTE activity/i.test(difference.description),
    ),
  );
});

test("changes in an unused CTE do not alter the outer metric", () => {
  const result = compareSqlQueries(
    `WITH unused AS (
       SELECT * FROM events WHERE event_name = 'login'
     )
     SELECT COUNT(*) FROM users`,
    `WITH unused AS (
       SELECT * FROM purchases WHERE status = 'paid'
     )
     SELECT COUNT(*) FROM users`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
  assert.ok(result.parser_limitations?.some((note) => /WITH\/CTE/.test(note)));
});
