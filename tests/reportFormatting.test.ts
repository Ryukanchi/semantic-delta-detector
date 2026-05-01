import test from "node:test";
import assert from "node:assert/strict";
import { compareSqlQueries } from "../src/analyzer/differenceEngine.js";
import { formatReadableReport } from "../src/output/formatReport.js";

test("readable report prioritizes verdict and impact with query blocks", () => {
  const queryA = "SELECT COUNT(*) FROM users WHERE status != 'deleted'";
  const queryB = "SELECT COUNT(*) FROM users";
  const result = compareSqlQueries(queryA, queryB);
  const report = formatReadableReport(result, queryA, queryB);

  assert.match(report, /^# Semantic Delta Result/);
  assert.match(report, /## Verdict\nMEDIUM RISK: This change may affect how the metric is interpreted\./);
  assert.match(report, /## Business Impact\nDecision risk: filter removal may alter the metric population\./);
  assert.match(report, /## Summary\n- Similarity: \d+\/100\n- Risk: medium\n- Confidence: \w+/);
  assert.match(report, /## Evidence\n- Query B removes the exclusion filter from Query A/i);
  assert.match(report, /## Recommendation\nConfirm whether including deleted users is intentional\./);
  assert.match(report, /## Query A\n```sql\nSELECT COUNT\(\*\) FROM users WHERE status != 'deleted'\n```/);
  assert.match(report, /## Query B\n```sql\nSELECT COUNT\(\*\) FROM users\n```/);
});

test("readable report falls back when verdict and impact are unavailable", () => {
  const result = compareSqlQueries("SELECT COUNT(*) FROM users", "SELECT COUNT(*) FROM users");
  const legacyResult = {
    ...result,
    verdict: undefined,
    impact: undefined,
  };
  const report = formatReadableReport(legacyResult);

  assert.match(report, /## Verdict\nNo significant semantic risk detected\./);
  assert.match(report, /## Business Impact\nNo significant business impact detected\./);
  assert.match(report, /## Evidence\n- No meaningful semantic differences detected\./);
  assert.match(report, /## Query A\n```sql\n-- Query text not available in this formatted result\.\n```/);
});
