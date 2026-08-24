import {
  compareMetricDefinitionsWithAnalysis,
} from "../analyzer/differenceEngine.js";
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
  parserLimitation?: string;
}

function analyzePostgresqlStructure(
  sql: string,
  queryLabel: "A" | "B",
): EnhancedStructureResult {
  const fallbackStructure = analyzeSqlStructure(sql);
  const externalResult = nodeSqlPostgresqlParser.parse(sql);
  if (externalResult.ok) {
    return {
      structure: {
        ...fallbackStructure,
        syntax: externalResult.syntax,
      },
    };
  }

  return {
    structure: fallbackStructure,
    parserLimitation: `Query ${queryLabel} could not be analyzed by the enhanced PostgreSQL syntax parser (${externalResult.reason}). Semantic Delta kept its lightweight fallback result, but confidence in the semantic verdict is limited for this query; review it manually.`,
  };
}

export function comparePostgresqlMetricDefinitions(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): SemanticComparisonResult {
  const enhancedA = analyzePostgresqlStructure(inputA.query, "A");
  const enhancedB = analyzePostgresqlStructure(inputB.query, "B");
  const parserLimitations = [
    enhancedA.parserLimitation,
    enhancedB.parserLimitation,
  ].filter((note): note is string => Boolean(note));

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
