import {
  compareMetricDefinitionsWithAnalysis,
} from "../analyzer/differenceEngine.js";
import { analyzeSourceRoles } from "../analyzer/sourceRoleCanonicalization.js";
import { nodeSqlPostgresqlParser } from "../parser/nodeSqlParserAdapter.js";
import {
  analyzeSqlStructure,
  type SqlStructureSummary,
} from "../parser/sqlStructure.js";
import type {
  MetricDefinitionInput,
  SemanticComparisonResult,
} from "../types.js";

interface EnhancedStructureResult {
  structure: SqlStructureSummary;
  analysisLimitations: string[];
}

function analyzePostgresqlStructure(
  sql: string,
  queryLabel: "A" | "B",
): EnhancedStructureResult {
  const fallbackStructure = analyzeSqlStructure(sql);
  const externalResult = nodeSqlPostgresqlParser.parse(sql);
  if (externalResult.ok) {
    const sourceRoleAnalysis = analyzeSourceRoles(externalResult.syntax);
    return {
      structure: {
        ...fallbackStructure,
        syntax: externalResult.syntax,
      },
      analysisLimitations:
        sourceRoleAnalysis.applicable && !sourceRoleAnalysis.safe
          ? sourceRoleAnalysis.limitations.map(
              (reason) =>
                `Query ${queryLabel} ${reason}. Semantic Delta kept its conservative positional fallback behavior, so confidence in the source-role verdict is limited; review this self-join manually.`,
            )
          : [],
    };
  }

  return {
    structure: fallbackStructure,
    analysisLimitations: [
      `Query ${queryLabel} could not be analyzed by the enhanced PostgreSQL syntax parser (${externalResult.reason}). Semantic Delta kept its lightweight fallback result, but confidence in the semantic verdict is limited for this query; review it manually.`,
    ],
  };
}

export function comparePostgresqlMetricDefinitions(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): SemanticComparisonResult {
  const enhancedA = analyzePostgresqlStructure(inputA.query, "A");
  const enhancedB = analyzePostgresqlStructure(inputB.query, "B");
  const parserLimitations = [
    ...enhancedA.analysisLimitations,
    ...enhancedB.analysisLimitations,
  ];

  return compareMetricDefinitionsWithAnalysis(inputA, inputB, {
    structureA: enhancedA.structure,
    structureB: enhancedB.structure,
    ...(parserLimitations.length > 0
      ? { parserLimitations, confidenceCap: "low" as const }
      : {}),
  });
}

export function comparePostgresqlSqlQueries(
  queryA: string,
  queryB: string,
): SemanticComparisonResult {
  return comparePostgresqlMetricDefinitions({ query: queryA }, { query: queryB });
}
