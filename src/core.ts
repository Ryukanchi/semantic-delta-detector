export {
  buildImpactLayer,
  buildVerdict,
  compareMetricDefinitions,
  compareSqlQueries,
} from "./analyzer/differenceEngine.js";

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
