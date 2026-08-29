export {
  buildImpactLayer,
  buildVerdict,
} from "./analyzer/differenceEngine.js";

export {
  comparePostgresqlMetricDefinitions as compareMetricDefinitions,
  comparePostgresqlSqlQueries as compareSqlQueries,
} from "./internal/enhancedSqlComparisonRuntime.js";

import {
  comparePostgresqlMetricDefinitionsIsolated,
  comparePostgresqlSqlQueriesIsolated,
} from "./internal/enhancedSqlComparisonRuntime.js";
import type {
  IsolatedPostgresqlComparisonOptions,
  MetricDefinitionInput,
  SemanticComparisonResult,
} from "./types.js";

export function compareMetricDefinitionsIsolated(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  options: IsolatedPostgresqlComparisonOptions = {},
): Promise<SemanticComparisonResult> {
  return comparePostgresqlMetricDefinitionsIsolated(inputA, inputB, options);
}

export function compareSqlQueriesIsolated(
  queryA: string,
  queryB: string,
  options: IsolatedPostgresqlComparisonOptions = {},
): Promise<SemanticComparisonResult> {
  return comparePostgresqlSqlQueriesIsolated(queryA, queryB, options);
}

export type {
  ConfidenceLevel,
  DetectedDifference,
  DifferenceCategory,
  EvidenceSource,
  ImpactLayer,
  IsolatedPostgresqlComparisonOptions,
  MetricDefinitionInput,
  RiskLevel,
  SemanticComparisonResult,
} from "./types.js";
