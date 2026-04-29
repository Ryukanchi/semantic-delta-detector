import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { compareMetricDefinitions, compareSqlQueries } from "../src/analyzer/differenceEngine.js";
import { parseFailOnThreshold, shouldFailForRisk } from "../src/ciGating.js";
import { fixtures } from "./fixtures.js";
import { formatPrComment } from "../src/output/formatPrComment.js";
import { formatReadableReport } from "../src/output/formatReport.js";

const repoRoot = process.cwd();
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxBinPath = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const prBeforePath = join(repoRoot, "examples", "pr-before.sql");
const prAfterPath = join(repoRoot, "examples", "pr-after.sql");

function withTempDir<T>(callback: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sdd-"));

  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("happy path returns strong similarity for equivalent queries", () => {
  const result = compareMetricDefinitions(fixtures.happyPath.inputA, fixtures.happyPath.inputB);

  assert.equal(result.risk_level, "low");
  assert.ok(result.semantic_similarity_score >= 90);
  assert.equal(result.detected_differences.length, 0);
  assert.equal(result.confidence_level, "low");
  assert.deepEqual(result.evidence_sources, ["sql_only"]);
});

test("formatting-only query changes produce a calm low-risk result", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE country = 'DE'",
    `SELECT COUNT(*)
FROM users
WHERE country = 'DE'`,
  );

  assert.equal(result.risk_level, "low");
  assert.ok(result.semantic_similarity_score >= 90);
  assert.equal(result.detected_differences.length, 0);
  assert.equal(result.verdict, "LOW RISK: No meaningful semantic change detected.");
  assert.ok(result.impact);
  assert.equal(result.impact.severity, "LOW");
  assert.equal(result.impact.decisionRisk, "No significant business impact detected.");
  assert.deepEqual(result.impact.evidence, []);
  assert.equal(result.recommendation, "No action required beyond normal review.");
  assert.equal(result.impact.recommendedAction, result.recommendation);
});

test("semantic mismatch flags engagement vs monetization clearly", () => {
  const result = compareMetricDefinitions(
    fixtures.semanticMismatch.inputA,
    fixtures.semanticMismatch.inputB,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(result.semantic_similarity_score < 45);
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "monetization_mismatch",
    ),
  );
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "metric_intent_mismatch",
    ),
  );
});

test("alias-only differences do not create fake metric or aggregation mismatches", () => {
  const result = compareMetricDefinitions(
    fixtures.aliasEdgeCase.inputA,
    fixtures.aliasEdgeCase.inputB,
  );

  assert.equal(result.metric_name_a, "users_metric");
  assert.equal(result.metric_name_b, "users_metric");
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "aggregation_mismatch",
    ),
  );
  assert.equal(result.risk_level, "low");
});

test("removed where filter explains broader measured population", () => {
  const result = compareSqlQueries(
    "SELECT * FROM events WHERE event = 'login'",
    "SELECT * FROM events",
  );

  assert.notEqual(result.risk_level, "low");
  assert.match(result.likely_business_meaning_a, /login events/i);
  assert.match(result.likely_business_meaning_b, /all events/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /Query B removes filter logic from Query A/i.test(difference.description) &&
        /measured population becomes broader/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) =>
        difference.category === "metric_intent_mismatch" &&
        /Query B is unknown/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) =>
        difference.category === "metric_intent_mismatch" &&
        difference.impact === "high",
    ),
  );
  assert.match(result.explanation, /filter scope changes the measured population/i);
  assert.match(result.explanation, /not just the SQL shape/i);
  assert.match(result.recommendation, /Confirm whether removing the filter is intentional/i);
  assert.match(result.recommendation, /Downstream dashboards/i);
  assert.equal(
    result.verdict,
    "MEDIUM RISK: This change may affect how the metric is interpreted.",
  );
  assert.ok(result.impact);
  assert.equal(result.impact.severity, "MEDIUM");
  assert.match(result.impact.decisionRisk, /filter removal may alter the metric population/i);
  assert.match(result.impact.affectedMeaning, /Query A: .*login events.*Query B: .*all events/i);
  assert.equal(result.impact.recommendedAction, result.recommendation);
  assert.deepEqual(
    result.impact.evidence,
    result.detected_differences.map((difference) => difference.description),
  );
});

test("paid users vs all users focuses on monetization gate removal", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE plan = 'paid'",
    "SELECT COUNT(*) FROM users",
  );

  assert.equal(result.risk_level, "high");
  assert.match(
    result.likely_business_meaning_a,
    /paid, subscribed, or monetized definition/i,
  );
  assert.match(result.likely_business_meaning_b, /all users/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "monetization_mismatch" &&
        /removes the monetization gate/i.test(difference.description) &&
        /monetized users/i.test(difference.description) &&
        /all users/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) =>
        difference.category === "metric_intent_mismatch" &&
        /unknown/i.test(difference.description),
    ),
  );
  assert.doesNotMatch(result.recommendation, /engagement/i);
  assert.match(result.recommendation, /paid-user counts with all-user counts/i);
});

test("login event time-window changes are called out without changing event concept", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM events WHERE event = 'login' AND created_at >= NOW() - INTERVAL '7 days'",
    "SELECT COUNT(*) FROM events WHERE event = 'login' AND created_at >= NOW() - INTERVAL '30 days'",
  );

  assert.equal(result.risk_level, "medium");
  assert.equal(result.confidence_level, "medium");
  assert.match(result.likely_business_meaning_a, /7-day login events/i);
  assert.match(result.likely_business_meaning_b, /30-day login events/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "time_reference_mismatch" &&
        difference.impact === "medium" &&
        /7 days in Query A vs 30 days in Query B/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "monetization_mismatch",
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /all events/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) =>
        difference.category === "metric_intent_mismatch" &&
        /unknown/i.test(difference.description),
    ),
  );
  assert.match(result.explanation, /reporting window differs/i);
  assert.match(result.recommendation, /time-window change is intentional/i);
  assert.match(result.recommendation, /7-day and 30-day counts/i);
});

test("reporting grain changes are called out without changing event concept", () => {
  const result = compareSqlQueries(
    "SELECT DATE(created_at), COUNT(*) FROM events WHERE event = 'login' GROUP BY DATE(created_at)",
    "SELECT DATE_TRUNC('month', created_at), COUNT(*) FROM events WHERE event = 'login' GROUP BY DATE_TRUNC('month', created_at)",
  );

  assert.equal(result.risk_level, "medium");
  assert.equal(result.confidence_level, "medium");
  assert.match(result.likely_business_meaning_a, /daily login event counts/i);
  assert.match(result.likely_business_meaning_b, /monthly login event counts/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "reporting_grain_mismatch" &&
        difference.impact === "medium" &&
        /reporting grain changed from daily to monthly/i.test(difference.description) &&
        /trend points are not directly comparable/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "aggregation_mismatch",
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /all events/i.test(difference.description),
    ),
  );
  assert.match(result.explanation, /reporting grain differs/i);
  assert.match(result.recommendation, /reporting-grain change is intentional/i);
  assert.match(result.recommendation, /daily and monthly login counts/i);
});

test("count of paid orders vs paid order revenue is explained as measure change", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM orders WHERE status = 'paid'",
    "SELECT SUM(amount) FROM orders WHERE status = 'paid'",
  );

  assert.equal(result.risk_level, "high");
  assert.match(result.likely_business_meaning_a, /count of paid orders/i);
  assert.match(result.likely_business_meaning_b, /total amount\/revenue from paid orders/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        /Aggregation changed from COUNT\(\*\) to SUM\(amount\)/i.test(difference.description),
    ),
  );
  assert.match(result.explanation, /filters match, but the metric measure changes/i);
  assert.match(result.explanation, /order volume\/count to monetary value\/revenue/i);
  assert.match(result.recommendation, /Do not compare paid order count and paid order revenue/i);
});

test("common revenue fields are treated as monetary aggregation measures", () => {
  const revenueFields = ["total", "revenue", "price"];

  for (const field of revenueFields) {
    const result = compareSqlQueries(
      "SELECT COUNT(*) FROM orders WHERE status = 'paid'",
      `SELECT SUM(${field}) FROM orders WHERE status = 'paid'`,
    );

    assert.match(result.likely_business_meaning_b, /total amount\/revenue from paid orders/i);
    assert.match(result.explanation, /monetary value\/revenue/i);
    assert.match(result.recommendation, /paid order count and paid order revenue/i);
  }
});

test("orders vs payments is treated as commerce source-of-truth risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM orders WHERE status = 'paid'",
    "SELECT COUNT(*) FROM payments WHERE status = 'paid'",
  );

  assert.equal(result.risk_level, "high");
  assert.match(result.likely_business_meaning_a, /count of paid orders/i);
  assert.match(result.likely_business_meaning_b, /count of paid payments/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "source_domain_mismatch" &&
        difference.impact === "high" &&
        /orders/i.test(difference.description) &&
        /payments/i.test(difference.description) &&
        /multiple payment attempts/i.test(difference.description) &&
        /refunds, retries, failures/i.test(difference.description) &&
        /business lifecycle/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "metric_intent_mismatch",
    ),
  );
  assert.match(result.explanation, /source of truth changes/i);
  assert.match(result.recommendation, /Confirm which source of truth is intended/i);
  assert.match(result.recommendation, /order-based and payment-based counts/i);
});

test("country segment changes are treated as cohort mismatch", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE country = 'DE'",
    "SELECT COUNT(*) FROM users WHERE country = 'US'",
  );

  assert.equal(result.risk_level, "medium");
  assert.match(result.likely_business_meaning_a, /DE users/i);
  assert.match(result.likely_business_meaning_b, /US users/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        difference.impact === "medium" &&
        /segment filter changes on country/i.test(difference.description) &&
        /different user cohorts\/segments/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "monetization_mismatch",
    ),
  );
  assert.doesNotMatch(result.explanation, /unknown/i);
  assert.doesNotMatch(result.explanation, /all users/i);
  assert.match(result.explanation, /segment filter changes the measured cohort/i);
  assert.match(result.recommendation, /segment change is intentional/i);
  assert.match(result.recommendation, /DE-user and US-user counts/i);
});

test("joins to another table are treated as population risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users u JOIN orders o ON u.id = o.user_id",
    "SELECT COUNT(*) FROM users",
  );

  assert.equal(result.risk_level, "high");
  assert.match(result.likely_business_meaning_a, /users joined with orders/i);
  assert.match(result.likely_business_meaning_a, /matching order records/i);
  assert.match(result.likely_business_meaning_b, /all users/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        difference.impact === "high" &&
        /Query A joins users to orders/i.test(difference.description) &&
        /Query B reads only users/i.test(difference.description) &&
        /restrict the population/i.test(difference.description) &&
        /multiply rows/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "metric_intent_mismatch",
    ),
  );
  assert.match(result.explanation, /JOIN changes the measured population/i);
  assert.match(result.explanation, /joined rows or users with matching joined records/i);
  assert.match(result.recommendation, /Confirm whether the JOIN is intentional/i);
  assert.match(result.recommendation, /counts users, orders, or joined rows/i);
  assert.equal(result.verdict, "HIGH RISK: This change alters the meaning of the metric.");
  assert.ok(result.impact);
  assert.equal(result.impact.severity, "HIGH");
  assert.match(result.impact.decisionRisk, /join changes may include or exclude users and change row counts/i);
  assert.ok(
    result.detected_differences.every((difference) =>
      result.impact?.evidence.includes(difference.description),
    ),
  );
});

test("join type changes are treated as population inclusion risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users u LEFT JOIN orders o ON u.id = o.user_id",
    "SELECT COUNT(*) FROM users u JOIN orders o ON u.id = o.user_id",
  );

  assert.equal(result.risk_level, "high");
  assert.match(result.likely_business_meaning_a, /all users with optional order matches/i);
  assert.match(result.likely_business_meaning_a, /possible order data/i);
  assert.match(result.likely_business_meaning_b, /users with matching order records/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "join_type_mismatch" &&
        difference.impact === "high" &&
        /join type changed from LEFT JOIN to INNER JOIN/i.test(difference.description) &&
        /users without orders may be excluded in Query B/i.test(difference.description) &&
        /not be directly comparable/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /reads only users/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "metric_intent_mismatch",
    ),
  );
  assert.match(result.explanation, /join type changes population inclusion/i);
  assert.match(result.recommendation, /join-type change is intentional/i);
  assert.match(result.recommendation, /users without orders should be included/i);
});

test("distinct user count vs event row count is treated as counted-unit change", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
    "SELECT COUNT(*) FROM events WHERE event = 'login'",
  );

  assert.equal(result.risk_level, "high");
  assert.match(result.likely_business_meaning_a, /unique users with login events/i);
  assert.match(result.likely_business_meaning_b, /login event rows/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        difference.impact === "high" &&
        /COUNT\(DISTINCT user_id\) to COUNT\(\*\)/i.test(difference.description) &&
        /Query A counts distinct user_id values, while Query B counts event rows/i.test(
          difference.description,
        ) &&
        /unique users to event rows/i.test(difference.description) &&
        /repeated events by the same user/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "metric_intent_mismatch",
    ),
  );
  assert.match(result.explanation, /counted unit changes/i);
  assert.match(result.explanation, /unique users while the other measures event-row volume/i);
  assert.match(result.recommendation, /unique-user login counts with login event-row counts/i);
  assert.match(result.recommendation, /count users or events/i);
});

test("removed exclusion filter explains broader deleted-user population", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE status != 'deleted'",
    "SELECT COUNT(*) FROM users",
  );

  assert.equal(result.risk_level, "medium");
  assert.match(result.likely_business_meaning_a, /users excluding deleted users/i);
  assert.match(result.likely_business_meaning_b, /all users/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        difference.impact === "medium" &&
        /removes the exclusion filter/i.test(difference.description) &&
        /status != 'deleted'/i.test(difference.description) &&
        /may now include deleted users/i.test(difference.description) &&
        /population becomes broader/i.test(difference.description),
    ),
  );
  assert.match(result.explanation, /removing the exclusion filter broadens the population/i);
  assert.match(result.recommendation, /including deleted users is intentional/i);
  assert.match(result.recommendation, /active\/non-deleted user counts with all-user counts/i);
});

test("common removed exclusion filters are treated as population broadening", () => {
  const filters = [
    "deleted_at IS NULL",
    "is_deleted = false",
    "is_test = false",
    "email NOT LIKE '%@company.com'",
  ];

  for (const filter of filters) {
    const result = compareSqlQueries(
      `SELECT COUNT(*) FROM users WHERE ${filter}`,
      "SELECT COUNT(*) FROM users",
    );

    assert.ok(
      result.detected_differences.some(
        (difference) =>
          difference.category === "business_logic_mismatch" &&
          /removes the exclusion filter/i.test(difference.description),
      ),
      `Expected removed exclusion filter for ${filter}`,
    );
  }
});

test("removed internal account exclusion explains broader internal/test population", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@company.com'",
    "SELECT COUNT(*) FROM users",
  );

  assert.equal(result.risk_level, "medium");
  assert.match(result.likely_business_meaning_a, /users excluding internal\/company accounts/i);
  assert.match(result.likely_business_meaning_b, /all users/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        difference.impact === "medium" &&
        /removes the exclusion filter/i.test(difference.description) &&
        /email NOT LIKE '%@company\.com'/i.test(difference.description) &&
        /employee\/internal\/test accounts/i.test(difference.description) &&
        /population becomes broader/i.test(difference.description),
    ),
  );
  assert.match(result.recommendation, /including internal\/test accounts is intentional/i);
  assert.match(result.recommendation, /external-user counts with all-user counts/i);
});

test("removed test-user exclusion explains broader test-user population", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_test = false",
    "SELECT COUNT(*) FROM users",
  );

  assert.match(result.likely_business_meaning_a, /users excluding test users/i);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /may now include test users/i.test(difference.description),
    ),
  );
  assert.match(result.recommendation, /including internal\/test accounts is intentional/i);
});

test("common monetization filters are treated as monetization gates", () => {
  const filters = [
    "plan = 'paid'",
    "subscription_status = 'active'",
    "is_paid = true",
    "revenue > 0",
  ];

  for (const filter of filters) {
    const result = compareSqlQueries(
      `SELECT COUNT(*) FROM users WHERE ${filter}`,
      "SELECT COUNT(*) FROM users",
    );

    assert.ok(
      result.detected_differences.some(
        (difference) =>
          difference.category === "monetization_mismatch" &&
          /removes the monetization gate/i.test(difference.description),
      ),
      `Expected monetization mismatch for ${filter}`,
    );
    assert.doesNotMatch(result.recommendation, /engagement/i);
  }
});

test("unusual count syntax does not produce engagement recommendation", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE plan = 'paid'",
    "SELECT COUNT * FROM users",
  );

  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "aggregation_mismatch",
    ),
  );
  assert.match(result.likely_business_meaning_b, /all users/i);
  assert.doesNotMatch(result.recommendation, /engagement/i);
  assert.match(result.recommendation, /paid-user counts with all-user counts/i);
});

test("metadata raises confidence when naming and context confirm divergence", () => {
  const result = compareMetricDefinitions(
    fixtures.metadataMismatch.inputA,
    fixtures.metadataMismatch.inputB,
  );

  assert.equal(result.metric_name_a, "active_users");
  assert.equal(result.metric_name_b, "active_users");
  assert.equal(result.confidence_level, "high");
  assert.ok(result.evidence_sources.includes("metric_name"));
  assert.ok(result.evidence_sources.includes("description"));
  assert.ok(result.evidence_sources.includes("team_context"));
  assert.ok(result.evidence_sources.includes("intended_use"));
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "naming_alignment_mismatch",
    ),
  );
});

test("partial metadata is called out accurately in the explanation", () => {
  const result = compareMetricDefinitions(
    fixtures.partialMetadata.inputA,
    fixtures.partialMetadata.inputB,
  );

  assert.equal(result.confidence_level, "high");
  assert.ok(result.evidence_sources.includes("metric_name"));
  assert.ok(result.evidence_sources.includes("description"));
  assert.match(result.explanation, /Partial metadata was available\./);
  assert.match(result.explanation, /Available on only one side: team context, intended use\./);
});

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

test("CLI PR examples include validated semantic cases", () => {
  const output = execFileSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--example",
      "unique-login-users-vs-login-event-rows",
      "--pr",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.match(output, /🔴 HIGH RISK/);
  assert.match(output, /Impact: aggregation changes may change what is counted\./);
  assert.match(output, /Evidence:\n- Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  assert.match(output, /Recommendation: Do not compare unique-user login counts/i);
});

test("CLI PR examples include a calm formatting-only low-risk case", () => {
  const output = execFileSync(
    "npm",
    ["run", "compare", "--", "--example", "same-de-users-formatting", "--pr"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.match(output, /🟢 LOW RISK/);
  assert.match(output, /No meaningful semantic change detected\./);
  assert.match(output, /Impact: No significant business impact detected\./);
  assert.match(output, /Recommendation: No action required beyond normal review\./);
});

test("unknown CLI example lists newly added examples", () => {
  assert.throws(
    () =>
      execFileSync("npm", ["run", "compare", "--", "--example", "missing-example"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      }),
    /Available examples: .*same-de-users-formatting.*unique-login-users-vs-login-event-rows.*paid-users-vs-all-users.*daily-login-counts-vs-monthly-login-counts.*left-join-vs-inner-join/,
  );
});

test("CLI PR simulation reads before and after SQL files", () => {
  const output = execFileSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--before",
      "./examples/pr-before.sql",
      "--after",
      "./examples/pr-after.sql",
      "--pr",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.match(output, /🔴 HIGH RISK/);
  assert.match(output, /Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  assert.match(output, /Confirm whether the metric is intended to count users or events\./);
});

test("CI severity gating compares risks against thresholds", () => {
  assert.equal(shouldFailForRisk("high", "high"), true);
  assert.equal(shouldFailForRisk("medium", "high"), false);
  assert.equal(shouldFailForRisk("high", "critical"), false);
  assert.equal(shouldFailForRisk("critical", "high"), true);
  assert.equal(parseFailOnThreshold("HIGH"), "high");
  assert.throws(
    () => parseFailOnThreshold("urgent"),
    /Invalid --fail-on value "urgent". Supported values: low, medium, high, critical\./,
  );
});

test("CLI --fail-on exits non-zero only at or above the configured threshold", () => {
  const highThreshold = spawnSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--before",
      "./examples/pr-before.sql",
      "--after",
      "./examples/pr-after.sql",
      "--pr",
      "--fail-on",
      "high",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(highThreshold.status, 1);
  assert.match(highThreshold.stdout, /🔴 HIGH RISK/);

  const criticalThreshold = spawnSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--before",
      "./examples/pr-before.sql",
      "--after",
      "./examples/pr-after.sql",
      "--pr",
      "--fail-on",
      "critical",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(criticalThreshold.status, 0);
  assert.match(criticalThreshold.stdout, /🔴 HIGH RISK/);
});

test("CLI --fail-on reports invalid thresholds clearly", () => {
  const result = spawnSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--before",
      "./examples/pr-before.sql",
      "--after",
      "./examples/pr-after.sql",
      "--pr",
      "--fail-on",
      "urgent",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Invalid --fail-on value "urgent". Supported values: low, medium, high, critical\./,
  );
});

test("missing semantic-delta.yml does not enable CI gating", () => {
  withTempDir((dir) => {
    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
  });
});

test("semantic-delta.yml fail_on high enables CI gating", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: high\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /🔴 HIGH RISK/);
  });
});

test("CLI --fail-on overrides semantic-delta.yml fail_on", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: high\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [
        cliPath,
        "--before",
        prBeforePath,
        "--after",
        prAfterPath,
        "--pr",
        "--fail-on",
        "critical",
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
  });
});

test("invalid semantic-delta.yml fail_on reports a clear error", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: urgent\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Invalid semantic-delta\.yml fail_on value "urgent". Supported values: low, medium, high, critical\./,
    );
  });
});

test("CLI PR simulation requires both before and after files", () => {
  assert.throws(
    () =>
      execFileSync(
        "npm",
        ["run", "compare", "--", "--before", "./examples/pr-before.sql", "--pr"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /Provide both --before and --after for PR simulation/,
  );
});

test("CLI PR simulation reports missing before and after files clearly", () => {
  assert.throws(
    () =>
      execFileSync(
        "npm",
        [
          "run",
          "compare",
          "--",
          "--before",
          "./examples/missing-before.sql",
          "--after",
          "./examples/pr-after.sql",
          "--pr",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /Before file does not exist: \.\/examples\/missing-before\.sql/,
  );

  assert.throws(
    () =>
      execFileSync(
        "npm",
        [
          "run",
          "compare",
          "--",
          "--before",
          "./examples/pr-before.sql",
          "--after",
          "./examples/missing-after.sql",
          "--pr",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /After file does not exist: \.\/examples\/missing-after\.sql/,
  );
});

test("cli reports friendly validation errors for malformed json metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdd-"));
  const badAPath = join(dir, "bad-a.json");
  const badBPath = join(dir, "bad-b.json");

  writeFileSync(
    badAPath,
    JSON.stringify({ metric_name: 123, query: "SELECT COUNT(*) FROM users" }),
    "utf8",
  );
  writeFileSync(
    badBPath,
    JSON.stringify({ query: "SELECT COUNT(*) FROM users" }),
    "utf8",
  );

  assert.throws(
    () =>
      execFileSync(
        "corepack",
        [
          "pnpm",
          "compare",
          "--json-a",
          badAPath,
          "--json-b",
          badBPath,
          "--format",
          "json",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /field "metric_name" must be a string if provided/,
  );
});
