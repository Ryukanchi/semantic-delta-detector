import { SemanticComparisonResult } from "../types.js";

function getCategoryLabel(category: string): string {
  const categoryLabels: Record<string, string> = {
    source_domain_mismatch: "Source Domain",
    business_logic_mismatch: "Business Logic",
    activity_basis_mismatch: "Activity Basis",
    monetization_mismatch: "Monetization",
    time_reference_mismatch: "Time Reference",
    reporting_grain_mismatch: "Reporting Grain",
    join_type_mismatch: "Join Type",
    aggregation_mismatch: "Aggregation",
    metric_intent_mismatch: "Metric Intent",
    team_context_mismatch: "Team Context",
    intended_use_mismatch: "Intended Use",
    description_mismatch: "Description",
    naming_alignment_mismatch: "Naming Conflict",
  };

  return categoryLabels[category] || category;
}

function sortFindingsByImportance(result: SemanticComparisonResult) {
  const impactOrder = { high: 0, medium: 1, low: 2 };

  return [...result.detected_differences].sort((left, right) => {
    const impactDelta = impactOrder[left.impact] - impactOrder[right.impact];
    if (impactDelta !== 0) {
      return impactDelta;
    }

    return getCategoryLabel(left.category).localeCompare(getCategoryLabel(right.category));
  });
}

function formatEvidence(result: SemanticComparisonResult): string[] {
  if (result.impact?.evidence.length) {
    return result.impact.evidence.map((evidence) => `- ${evidence}`);
  }

  if (result.detected_differences.length === 0) {
    return ["- No meaningful semantic differences detected."];
  }

  return sortFindingsByImportance(result).map(
    (difference) =>
      `- [${difference.impact.toUpperCase()}] ${getCategoryLabel(difference.category)}: ${difference.description}`,
  );
}

function formatSqlBlock(query: string | undefined): string[] {
  return [
    "```sql",
    query?.trim() || "-- Query text not available in this formatted result.",
    "```",
  ];
}

export function formatReadableReport(
  result: SemanticComparisonResult,
  queryA?: string,
  queryB?: string,
): string {
  const verdict = result.verdict || "No significant semantic risk detected.";
  const businessImpact =
    result.impact?.decisionRisk || "No significant business impact detected.";
  const recommendation = result.impact?.recommendedAction || result.recommendation;

  return [
    "# Semantic Delta Result",
    "",
    "## Verdict",
    verdict,
    "",
    "## Business Impact",
    businessImpact,
    "",
    "## Summary",
    `- Similarity: ${result.semantic_similarity_score}/100`,
    `- Risk: ${result.risk_level}`,
    `- Confidence: ${result.confidence_level}`,
    "",
    "## Evidence",
    ...formatEvidence(result),
    "",
    "## Business Meaning",
    `- Query A (${result.metric_name_a}): ${result.likely_business_meaning_a}`,
    `- Query B (${result.metric_name_b}): ${result.likely_business_meaning_b}`,
    "",
    "## Recommendation",
    recommendation,
    "",
    "## Query A",
    ...formatSqlBlock(queryA),
    "",
    "## Query B",
    ...formatSqlBlock(queryB),
  ].join("\n");
}

function buildVerdict(result: SemanticComparisonResult): string {
  if (result.risk_level === "high") {
    return "HIGH SEMANTIC CONFLICT";
  }

  if (result.risk_level === "medium") {
    return "MEANINGFUL DEFINITION DRIFT";
  }

  return "LOW SEMANTIC RISK";
}

function buildInterchangeabilityLabel(result: SemanticComparisonResult): string {
  if (result.semantic_similarity_score < 45) {
    return "Not safely interchangeable";
  }

  if (result.semantic_similarity_score < 75) {
    return "Comparable only with explicit caveats";
  }

  return "Likely interchangeable";
}

function buildHeadline(result: SemanticComparisonResult): string {
  if (result.detected_differences.some((difference) => difference.category === "metric_intent_mismatch")) {
    return "These queries may look similar, but they do not measure the same business concept.";
  }

  if (result.risk_level === "high") {
    return "These query definitions conflict in ways that can change business decisions.";
  }

  if (result.risk_level === "medium") {
    return "These query definitions are close, but not identical.";
  }

  return "These query definitions are closely aligned.";
}

function buildWhyItMatters(result: SemanticComparisonResult): string {
  if (
    result.detected_differences.some((difference) => difference.category === "monetization_mismatch") &&
    result.detected_differences.some((difference) => difference.category === "activity_basis_mismatch")
  ) {
    return "One metric reflects product engagement, while the other mixes activity with monetization. Using them as if they were the same KPI can blur product health, revenue health, and executive reporting.";
  }

  if (result.risk_level === "high") {
    return "Different metric definitions here can drive different product, finance, or growth decisions even if the labels sound similar.";
  }

  if (result.risk_level === "medium") {
    return "Teams could reach different conclusions unless the metric definition is made explicit.";
  }

  return "This comparison does not show major semantic conflict.";
}

export function formatDemoReport(result: SemanticComparisonResult): string {
  const topFindings = sortFindingsByImportance(result).slice(0, 3);
  const findingLines =
    topFindings.length === 0
      ? ["- No major semantic conflict detected."]
      : topFindings.map(
          (difference) =>
            `- ${getCategoryLabel(difference.category)}: ${difference.description}`,
        );

  return [
    "Semantic Delta Demo",
    "===================",
    `Verdict: ${buildVerdict(result)}`,
    `Interchangeability: ${buildInterchangeabilityLabel(result)}`,
    `Similarity Score: ${result.semantic_similarity_score}/100`,
    `Confidence: ${result.confidence_level}`,
    `Evidence: ${result.evidence_sources.join(", ")}`,
    "",
    buildHeadline(result),
    "",
    "What Each Query Really Measures",
    `- Query A (${result.metric_name_a}): ${result.likely_business_meaning_a}`,
    `- Query B (${result.metric_name_b}): ${result.likely_business_meaning_b}`,
    "",
    "Why This Matters",
    buildWhyItMatters(result),
    "",
    "Top Semantic Conflicts",
    ...findingLines,
    "",
    "Recommended Action",
    result.recommendation,
  ].join("\n");
}
