export {
  buildImpactLayer,
  buildVerdict,
} from "./analyzer/differenceEngine.js";

export {
  comparePostgresqlMetricDefinitions as compareMetricDefinitions,
  comparePostgresqlSqlQueries as compareSqlQueries,
} from "./internal/enhancedSqlComparisonRuntime.js";

export type {
  ConfidenceLevel,
  DetectedDifference,
  DifferenceCategory,
  EvidenceSource,
  ImpactLayer,
  MetricDefinitionInput,
  RiskLevel,
  SemanticComparisonResult,
} from "./types.js";
