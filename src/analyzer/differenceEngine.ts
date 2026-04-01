import { tokenizeSql } from "../parser/sqlTokenizer.js";
import {
  buildSemanticProfile,
  estimateBaseSimilarity,
  inferDimensionFromMetadata,
  inferRiskLevel,
  normalizeText,
} from "./semanticHeuristics.js";
import {
  ConfidenceLevel,
  DetectedDifference,
  EvidenceSource,
  MetricDefinitionInput,
  ParsedSqlQuery,
  QuerySemanticProfile,
  SemanticComparisonResult,
} from "../types.js";

function pushDifference(
  differences: DetectedDifference[],
  difference: DetectedDifference | null,
): void {
  if (difference) {
    differences.push(difference);
  }
}

function normalizeMetricInput(input: MetricDefinitionInput): MetricDefinitionInput {
  return {
    query: input.query.trim(),
    metric_name: input.metric_name?.trim() || undefined,
    team_context: input.team_context?.trim() || undefined,
    description: input.description?.trim() || undefined,
    intended_use: input.intended_use?.trim() || undefined,
  };
}

function getDisplayMetricName(
  input: MetricDefinitionInput,
  parsedQuery: ParsedSqlQuery,
): string {
  return input.metric_name || parsedQuery.metricName;
}

function compareMetricNameAlignment(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  const nameA = normalizeText(inputA.metric_name);
  const nameB = normalizeText(inputB.metric_name);
  if (!nameA || !nameB || nameA !== nameB) {
    return null;
  }

  if (profileA.primaryDimension === profileB.primaryDimension) {
    return null;
  }

  return {
    category: "naming_alignment_mismatch",
    description: `Both inputs use the same metric name (${inputA.metric_name}), but the underlying logic points to different meanings: Query A is ${profileA.primaryDimension}, while Query B is ${profileB.primaryDimension}.`,
    impact: "high",
  };
}

function compareSourceDomain(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  const sameTable = queryA.tables.some((table) => queryB.tables.includes(table));
  if (sameTable || profileA.sourceDomain === profileB.sourceDomain) {
    return null;
  }

  return {
    category: "source_domain_mismatch",
    description: `The queries pull from different source domains: Query A uses ${profileA.sourceDomain} data (${queryA.tables.join(", ") || "unknown"}), while Query B uses ${profileB.sourceDomain} data (${queryB.tables.join(", ") || "unknown"}).`,
    impact: "high",
  };
}

function compareAggregation(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): DetectedDifference | null {
  if (
    queryA.aggregation === queryB.aggregation &&
    queryA.aggregationDistinctTarget === queryB.aggregationDistinctTarget
  ) {
    return null;
  }

  return {
    category: "aggregation_mismatch",
    description: `The rollup logic differs: Query A uses ${queryA.aggregation || "no aggregation"} over ${queryA.aggregationDistinctTarget || "*"}, while Query B uses ${queryB.aggregation || "no aggregation"} over ${queryB.aggregationDistinctTarget || "*"}.`,
    impact: "high",
  };
}

function compareTimeReference(
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  if (!profileA.timeField && !profileB.timeField && !profileA.timeHorizon && !profileB.timeHorizon) {
    return null;
  }

  if (profileA.timeHorizon && profileA.timeHorizon === profileB.timeHorizon) {
    const engagementInvolved =
      profileA.primaryDimension === "engagement" ||
      profileB.primaryDimension === "engagement" ||
      profileA.secondaryDimensions.includes("engagement") ||
      profileB.secondaryDimensions.includes("engagement");

    if (engagementInvolved && profileA.timeField !== profileB.timeField) {
      return null;
    }

    if (profileA.timeField && profileB.timeField && profileA.timeField !== profileB.timeField) {
      return {
        category: "time_reference_mismatch",
        description: `Both queries use the same ${profileA.timeHorizon} horizon, but anchor it to different fields: Query A uses ${profileA.timeField}, while Query B uses ${profileB.timeField}. This changes what "recent" means operationally.`,
        impact: "medium",
      };
    }

    return null;
  }

  if (profileA.timeHorizon !== profileB.timeHorizon) {
    return {
      category: "time_reference_mismatch",
      description: `The queries use different recency windows: ${profileA.timeHorizon || "unspecified"} in Query A vs ${profileB.timeHorizon || "unspecified"} in Query B.`,
      impact: "medium",
    };
  }

  return null;
}

function compareActivityBasis(
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  const engagementInvolved =
    profileA.primaryDimension === "engagement" ||
    profileB.primaryDimension === "engagement" ||
    profileA.secondaryDimensions.includes("engagement") ||
    profileB.secondaryDimensions.includes("engagement");

  if (!engagementInvolved) {
    return null;
  }

  if (!profileA.timeField && !profileB.timeField && profileA.sourceDomain === profileB.sourceDomain) {
    return null;
  }

  if (profileA.timeField === profileB.timeField && profileA.primaryDimension === profileB.primaryDimension) {
    return null;
  }

  return {
    category: "activity_basis_mismatch",
    description: `The activity basis is different. Query A defines recency through ${profileA.timeField || profileA.sourceDomain}, while Query B defines it through ${profileB.timeField || profileB.sourceDomain}. They do not use the same operational definition of activity.`,
    impact: "high",
  };
}

function compareMonetization(
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): DetectedDifference | null {
  const aMonetized =
    profileA.primaryDimension === "monetization" ||
    profileA.secondaryDimensions.includes("monetization");
  const bMonetized =
    profileB.primaryDimension === "monetization" ||
    profileB.secondaryDimensions.includes("monetization");

  if (aMonetized === bMonetized) {
    return null;
  }

  const aSignal = queryA.filters.find((filter) => /paid|subscription|plan|mrr|arr/i.test(filter));
  const bSignal = queryB.filters.find((filter) => /paid|subscription|plan|mrr|arr/i.test(filter));

  return {
    category: "monetization_mismatch",
    description: `Only one query includes a monetization gate. Query A: ${aSignal || "no monetization condition detected"}. Query B: ${bSignal || "no monetization condition detected"}.`,
    impact: "high",
  };
}

function compareBusinessLogic(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  const ignorePatterns = [
    /paid|subscription|plan|mrr|arr/i,
    /event\s*=|last_active|event_date|created_at|current_date|current_timestamp|interval/i,
  ];
  const onlyInA = queryA.filters.filter(
    (value) => !queryB.filters.includes(value) && !ignorePatterns.some((pattern) => pattern.test(value)),
  );
  const onlyInB = queryB.filters.filter(
    (value) => !queryA.filters.includes(value) && !ignorePatterns.some((pattern) => pattern.test(value)),
  );

  if (onlyInA.length === 0 && onlyInB.length === 0) {
    return null;
  }

  const sameEntitySpace = profileA.entityLabel === profileB.entityLabel;
  const impact = sameEntitySpace ? "medium" : "high";

  return {
    category: "business_logic_mismatch",
    description: `The inclusion logic is different. Query A keeps ${onlyInA.join("; ") || "no unique filters"}, while Query B keeps ${onlyInB.join("; ") || "no unique filters"}. This changes who qualifies for the metric.`,
    impact,
  };
}

function compareDescriptions(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): DetectedDifference | null {
  const descriptionA = normalizeText(inputA.description);
  const descriptionB = normalizeText(inputB.description);
  if (!descriptionA || !descriptionB || descriptionA === descriptionB) {
    return null;
  }

  const dimensionA = inferDimensionFromMetadata(inputA);
  const dimensionB = inferDimensionFromMetadata(inputB);
  const impact =
    dimensionA !== "unknown" && dimensionB !== "unknown" && dimensionA !== dimensionB
      ? "high"
      : "medium";

  return {
    category: "description_mismatch",
    description: `The metric descriptions do not align. Query A is described as "${inputA.description}", while Query B is described as "${inputB.description}".`,
    impact,
  };
}

function compareTeamContext(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): DetectedDifference | null {
  const teamA = normalizeText(inputA.team_context);
  const teamB = normalizeText(inputB.team_context);
  if (!teamA || !teamB || teamA === teamB) {
    return null;
  }

  return {
    category: "team_context_mismatch",
    description: `The metrics come from different team contexts: Query A is tagged for ${inputA.team_context}, while Query B is tagged for ${inputB.team_context}.`,
    impact: "medium",
  };
}

function compareIntendedUse(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): DetectedDifference | null {
  const useA = normalizeText(inputA.intended_use);
  const useB = normalizeText(inputB.intended_use);
  if (!useA || !useB || useA === useB) {
    return null;
  }

  return {
    category: "intended_use_mismatch",
    description: `The intended uses differ: Query A is meant for ${inputA.intended_use}, while Query B is meant for ${inputB.intended_use}.`,
    impact: "medium",
  };
}

function compareMetricIntent(
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  if (profileA.businessMeaning === profileB.businessMeaning) {
    return null;
  }

  return {
    category: "metric_intent_mismatch",
    description: `The metrics point to different business concepts: Query A is ${profileA.primaryDimension}, while Query B is ${profileB.primaryDimension}.`,
    impact: "high",
  };
}

function deriveEvidenceSources(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  differences: DetectedDifference[],
): EvidenceSource[] {
  const categories = new Set(differences.map((difference) => difference.category));
  const metadataEvidence = new Set<EvidenceSource>();

  if (
    categories.has("naming_alignment_mismatch") &&
    inputA.metric_name &&
    inputB.metric_name
  ) {
    metadataEvidence.add("metric_name");
  }

  if (categories.has("description_mismatch") && inputA.description && inputB.description) {
    metadataEvidence.add("description");
  }

  if (categories.has("team_context_mismatch") && inputA.team_context && inputB.team_context) {
    metadataEvidence.add("team_context");
  }

  if (categories.has("intended_use_mismatch") && inputA.intended_use && inputB.intended_use) {
    metadataEvidence.add("intended_use");
  }

  if (metadataEvidence.size === 0) {
    return ["sql_only"];
  }

  return ["sql", ...metadataEvidence];
}

function inferConfidenceLevel(
  evidenceSources: EvidenceSource[],
  differences: DetectedDifference[],
): ConfidenceLevel {
  if (evidenceSources.includes("sql_only")) {
    return differences.length > 0 ? "medium" : "low";
  }

  const metadataCount = evidenceSources.filter((source) => source !== "sql").length;
  if (metadataCount >= 2) {
    return "high";
  }

  return "medium";
}

function buildExplanation(
  similarity: number,
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  differences: DetectedDifference[],
  confidenceLevel: ConfidenceLevel,
  evidenceSources: EvidenceSource[],
): string {
  const missingMetadata = [
    !inputA.metric_name || !inputB.metric_name ? "metric names" : null,
    !inputA.description || !inputB.description ? "descriptions" : null,
    !inputA.team_context || !inputB.team_context ? "team context" : null,
    !inputA.intended_use || !inputB.intended_use ? "intended use" : null,
  ].filter(Boolean) as string[];

  const evidenceNote =
    evidenceSources.includes("sql_only")
      ? "This is a heuristic warning based on SQL structure alone, so confidence is more limited."
      : `Confidence is ${confidenceLevel} because the SQL signal is supported by ${evidenceSources
          .filter((source) => source !== "sql")
          .join(", ")} metadata.`;

  const missingMetadataNote =
    missingMetadata.length > 0
      ? ` Missing context: ${missingMetadata.join(", ")}.`
      : "";

  if (differences.length === 0) {
    return `These definitions are close enough to support the same business interpretation. They use similar logic, time framing, and metric intent. ${evidenceNote}${missingMetadataNote}`;
  }

  const sameEntitySpace = profileA.entityLabel === profileB.entityLabel;
  const broadEntityText = sameEntitySpace
    ? `Both definitions operate in the same broad entity space (${profileA.entityLabel})`
    : `The definitions do not even operate over the same entity space (${profileA.entityLabel} vs ${profileB.entityLabel})`;

  if (profileA.primaryDimension !== profileB.primaryDimension) {
    return `${broadEntityText}, but they do not measure the same business concept. Query A measures ${profileA.primaryDimension === "engagement" ? "recent product engagement" : profileA.primaryDimension}, while Query B measures ${profileB.primaryDimension === "monetization" ? "monetized or paying activity" : profileB.primaryDimension}. They may look similar structurally, but they support different business decisions and should not be treated as interchangeable. ${evidenceNote}${missingMetadataNote}`;
  }

  if (similarity < 45) {
    return `${broadEntityText}, but the operational definition is materially different. Differences in activity basis, qualification rules, or time reference mean the metrics can diverge even if teams use similar names. ${evidenceNote}${missingMetadataNote}`;
  }

  return `${broadEntityText}, but there are still definition-level differences that should be documented before the metrics are compared in reporting. ${evidenceNote}${missingMetadataNote}`;
}

function buildRecommendation(
  similarity: number,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  differences: DetectedDifference[],
): string {
  const categories = new Set(differences.map((difference) => difference.category));

  if (
    categories.has("monetization_mismatch") &&
    (categories.has("activity_basis_mismatch") ||
      categories.has("metric_intent_mismatch") ||
      categories.has("team_context_mismatch"))
  ) {
    return "Use separate metric names for engagement and monetized activity. Do not compare these results in the same KPI trendline without an explicit metric contract, and clarify whether the audience is product, finance, or executive reporting.";
  }

  if (categories.has("time_reference_mismatch")) {
    return "Document which timestamp defines recency for this metric. Teams should align on whether the intended basis is event activity, account state, or another operational clock.";
  }

  if (categories.has("intended_use_mismatch")) {
    return "Clarify the intended audience and use case for each metric before combining them in shared reporting.";
  }

  if (similarity < 45 || profileA.primaryDimension !== profileB.primaryDimension) {
    return "Do not treat these metrics as interchangeable. Publish a short metric contract that names the source domain, qualification rules, and intended business use of each definition.";
  }

  if (differences.length > 0) {
    return "Keep the metrics separately documented and call out the qualification rules directly in dashboards or metric specs.";
  }

  return "These metrics are reasonably aligned, but keep a written definition so future changes do not create semantic drift.";
}

export function compareMetricDefinitions(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): SemanticComparisonResult {
  const normalizedInputA = normalizeMetricInput(inputA);
  const normalizedInputB = normalizeMetricInput(inputB);
  const parsedA = tokenizeSql(normalizedInputA.query);
  const parsedB = tokenizeSql(normalizedInputB.query);
  const profileA = buildSemanticProfile(parsedA);
  const profileB = buildSemanticProfile(parsedB);
  const likelyBusinessMeaningA = profileA.businessMeaning;
  const likelyBusinessMeaningB = profileB.businessMeaning;

  const detectedDifferences: DetectedDifference[] = [];
  pushDifference(
    detectedDifferences,
    compareMetricNameAlignment(normalizedInputA, normalizedInputB, profileA, profileB),
  );
  pushDifference(detectedDifferences, compareSourceDomain(parsedA, parsedB, profileA, profileB));
  pushDifference(detectedDifferences, compareAggregation(parsedA, parsedB));
  pushDifference(detectedDifferences, compareTimeReference(profileA, profileB));
  pushDifference(detectedDifferences, compareActivityBasis(profileA, profileB));
  pushDifference(detectedDifferences, compareMonetization(profileA, profileB, parsedA, parsedB));
  pushDifference(detectedDifferences, compareBusinessLogic(parsedA, parsedB, profileA, profileB));
  pushDifference(detectedDifferences, compareDescriptions(normalizedInputA, normalizedInputB));
  pushDifference(detectedDifferences, compareTeamContext(normalizedInputA, normalizedInputB));
  pushDifference(detectedDifferences, compareIntendedUse(normalizedInputA, normalizedInputB));
  pushDifference(detectedDifferences, compareMetricIntent(profileA, profileB));

  const semanticSimilarityScore = estimateBaseSimilarity(parsedA, parsedB);
  const riskLevel = inferRiskLevel(semanticSimilarityScore);
  const evidenceSources = deriveEvidenceSources(
    normalizedInputA,
    normalizedInputB,
    detectedDifferences,
  );
  const confidenceLevel = inferConfidenceLevel(evidenceSources, detectedDifferences);

  return {
    metric_name_a: getDisplayMetricName(normalizedInputA, parsedA),
    metric_name_b: getDisplayMetricName(normalizedInputB, parsedB),
    semantic_similarity_score: semanticSimilarityScore,
    detected_differences: detectedDifferences,
    likely_business_meaning_a: likelyBusinessMeaningA,
    likely_business_meaning_b: likelyBusinessMeaningB,
    risk_level: riskLevel,
    confidence_level: confidenceLevel,
    evidence_sources: evidenceSources,
    explanation: buildExplanation(
      semanticSimilarityScore,
      normalizedInputA,
      normalizedInputB,
      profileA,
      profileB,
      detectedDifferences,
      confidenceLevel,
      evidenceSources,
    ),
    recommendation: buildRecommendation(
      semanticSimilarityScore,
      profileA,
      profileB,
      detectedDifferences,
    ),
  };
}

export function compareSqlQueries(queryA: string, queryB: string): SemanticComparisonResult {
  return compareMetricDefinitions({ query: queryA }, { query: queryB });
}
