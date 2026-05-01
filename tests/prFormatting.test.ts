import test from "node:test";
import assert from "node:assert/strict";
import { compareMetricDefinitions, compareSqlQueries } from "../src/analyzer/differenceEngine.js";
import { formatPrComment } from "../src/output/formatPrComment.js";

test("PR comment formatter returns a short actionable comment", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
    "SELECT COUNT(*) FROM events WHERE event = 'login'",
  );
  const comment = formatPrComment(result);

  assert.equal(result.risk_level, "high");
  assert.match(comment, /^🔴 HIGH RISK\nThis change alters the meaning of the metric\./);
  assert.match(comment, /Impact: aggregation changes may change what is counted\./);
  assert.doesNotMatch(comment, /Impact: (Decision risk|Decision Risk|Risk):/);
  assert.match(comment, /Evidence:\n- Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  assert.match(comment, /Recommendation: Do not compare unique-user login counts/i);
  assert.doesNotMatch(comment, /## Summary|Key Findings|Business Meaning/);
  assert.ok(comment.split("\n").filter((line) => line.startsWith("- ")).length <= 2);
  assert.ok(comment.split("\n").length <= 10);
});

test("PR comment for formatting-only changes is calm and non-blocking", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE country = 'DE'",
    `SELECT COUNT(*)
FROM users
WHERE country = 'DE'`,
  );
  const comment = formatPrComment(result);

  assert.match(comment, /^🟢 LOW RISK\nNo meaningful semantic change detected\./);
  assert.match(comment, /Impact: No significant business impact detected\./);
  assert.match(comment, /Evidence:\n- No significant semantic differences detected\./);
  assert.match(comment, /Recommendation: No action required beyond normal review\./);
  assert.doesNotMatch(comment, /Do not|Confirm whether|Decision risk|alters the meaning/i);
});

test("PR comment keeps evidence aligned with the recommendation", () => {
  const result = compareMetricDefinitions(
    {
      metric_name: "login_users",
      query: "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
    },
    {
      metric_name: "paid_active_users",
      query: "SELECT COUNT(*) FROM users WHERE subscription_status = 'paid'",
    },
  );
  const comment = formatPrComment(result);

  assert.match(comment, /Impact: .*filter removal may alter the metric population\./);
  assert.doesNotMatch(comment, /Impact: (Decision risk|Decision Risk|Risk):/);
  assert.match(comment, /Evidence:\n- Query B removes filter logic from Query A/);
  assert.match(comment, /Recommendation: Confirm whether removing the filter is intentional\./);
  assert.ok(comment.split("\n").filter((line) => line.startsWith("- ")).length <= 2);
});
