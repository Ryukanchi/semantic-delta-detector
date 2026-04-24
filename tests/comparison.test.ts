import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { compareMetricDefinitions, compareSqlQueries } from "../src/analyzer/differenceEngine.js";
import { fixtures } from "./fixtures.js";

test("happy path returns strong similarity for equivalent queries", () => {
  const result = compareMetricDefinitions(fixtures.happyPath.inputA, fixtures.happyPath.inputB);

  assert.equal(result.risk_level, "low");
  assert.ok(result.semantic_similarity_score >= 90);
  assert.equal(result.detected_differences.length, 0);
  assert.equal(result.confidence_level, "low");
  assert.deepEqual(result.evidence_sources, ["sql_only"]);
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
