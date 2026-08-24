import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/core.js";

test("an IN subquery source change does not masquerade as an outer-table change", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*) FROM users
     WHERE user_id IN (SELECT user_id FROM purchases)`,
    `SELECT COUNT(*) FROM users
     WHERE user_id IN (SELECT user_id FROM logins)`,
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "source_domain_mismatch" &&
        /IN subquery/i.test(difference.description) &&
        /purchases/i.test(difference.description) &&
        /logins/i.test(difference.description) &&
        /outer source users remains unchanged/i.test(difference.description),
    ),
  );
});

test("EXISTS to NOT EXISTS is an explicit high-risk population inversion", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*) FROM users u
     WHERE EXISTS (
       SELECT 1 FROM purchases p WHERE p.user_id = u.id
     )`,
    `SELECT COUNT(*) FROM users u
     WHERE NOT EXISTS (
       SELECT 1 FROM purchases p WHERE p.user_id = u.id
     )`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "filter_logic_mismatch" &&
        /EXISTS/i.test(difference.description) &&
        /NOT EXISTS/i.test(difference.description) &&
        /inverts/i.test(difference.description),
    ),
  );
});

test("derived-table source changes remain visible in their own scope", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM (SELECT user_id FROM purchases) purchased_users",
    "SELECT COUNT(*) FROM (SELECT user_id FROM logins) logged_in_users",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "source_domain_mismatch" &&
        /derived-table subquery/i.test(difference.description) &&
        /purchases/i.test(difference.description) &&
        /logins/i.test(difference.description),
    ),
  );
});

test("alias renames across a correlated subquery remain equivalent", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*) FROM users u
     WHERE EXISTS (
       SELECT 1 FROM purchases p WHERE p.user_id = u.id
     )`,
    `SELECT COUNT(*) FROM users customer
     WHERE EXISTS (
       SELECT 1 FROM purchases purchase
       WHERE purchase.user_id = customer.id
     )`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});

test("changing a correlated inner-column reference remains visible", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*) FROM users u
     WHERE EXISTS (
       SELECT 1 FROM purchases p WHERE p.user_id = u.id
     )`,
    `SELECT COUNT(*) FROM users u
     WHERE EXISTS (
       SELECT 1 FROM purchases p WHERE p.id = u.id
     )`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /correlated EXISTS subquery/i.test(difference.description) &&
        /purchases\.user_id/i.test(difference.description) &&
        /purchases\.id/i.test(difference.description),
    ),
  );
});

test("aggregation changes inside a subquery are compared in that scope", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*) FROM users u
     WHERE u.id IN (
       SELECT user_id FROM orders GROUP BY user_id HAVING SUM(amount) > 100
     )`,
    `SELECT COUNT(*) FROM users u
     WHERE u.id IN (
       SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) > 100
     )`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        /IN subquery/i.test(difference.description) &&
        /SUM\(amount\)/i.test(difference.description) &&
        /COUNT\(\*\)/i.test(difference.description),
    ),
  );
});
