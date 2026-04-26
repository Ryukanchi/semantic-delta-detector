export type RiskLevel = "low" | "medium" | "high";
export type ConfidenceLevel = "low" | "medium" | "high";
export type EvidenceSource =
  | "sql_only"
  | "sql"
  | "metric_name"
  | "description"
  | "team_context"
  | "intended_use";
export type DifferenceCategory =
  | "source_domain_mismatch"
  | "business_logic_mismatch"
  | "activity_basis_mismatch"
  | "monetization_mismatch"
  | "time_reference_mismatch"
  | "reporting_grain_mismatch"
  | "join_type_mismatch"
  | "aggregation_mismatch"
  | "metric_intent_mismatch"
  | "team_context_mismatch"
  | "intended_use_mismatch"
  | "description_mismatch"
  | "naming_alignment_mismatch";
export type BusinessDimension =
  | "engagement"
  | "monetization"
  | "eligibility"
  | "acquisition"
  | "population"
  | "revenue"
  | "unknown";

export interface ParsedSqlQuery {
  rawQuery: string;
  normalizedQuery: string;
  tables: string[];
  selectedExpressions: string[];
  aggregation: string | null;
  aggregationDistinctTarget: string | null;
  metricName: string;
  whereClause: string | null;
  groupByExpressions: string[];
  joinClauses: SqlJoinClause[];
  filters: string[];
  timeWindows: string[];
  conditions: string[];
}

export interface SqlJoinClause {
  type: "inner" | "left" | "right" | "full" | "cross";
  table: string;
}

export interface DetectedDifference {
  category: DifferenceCategory;
  description: string;
  impact: "low" | "medium" | "high";
}

export interface ImpactLayer {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  decisionRisk: string;
  affectedMeaning: string;
  recommendedAction: string;
  evidence: string[];
}

export interface QuerySemanticProfile {
  primaryDimension: BusinessDimension;
  secondaryDimensions: BusinessDimension[];
  entityLabel: string;
  sourceDomain: string;
  timeField: string | null;
  timeHorizon: string | null;
  businessMeaning: string;
}

export interface MetricDefinitionInput {
  query: string;
  metric_name?: string;
  team_context?: string;
  description?: string;
  intended_use?: string;
}

export interface SemanticComparisonResult {
  metric_name_a: string;
  metric_name_b: string;
  semantic_similarity_score: number;
  detected_differences: DetectedDifference[];
  likely_business_meaning_a: string;
  likely_business_meaning_b: string;
  risk_level: RiskLevel;
  confidence_level: ConfidenceLevel;
  evidence_sources: EvidenceSource[];
  explanation: string;
  recommendation: string;
  verdict?: string;
  impact?: ImpactLayer;
}

export interface ExampleQueryPair {
  id: string;
  title: string;
  description: string;
  queryAName: string;
  queryBName: string;
  queryA: string;
  queryB: string;
}
