import {
  compareMetricDefinitionsWithAnalysis,
} from "../analyzer/differenceEngine.js";
import { analyzeSourceRoles } from "../analyzer/sourceRoleCanonicalization.js";
import { nodeSqlPostgresqlParser } from "../parser/nodeSqlParserAdapter.js";
import type { ExternalSqlParseResult } from "../parser/externalSqlParser.js";
import {
  analyzeSqlStructure,
  type SqlStructureSummary,
} from "../parser/sqlStructure.js";
import type {
  IsolatedPostgresqlComparisonOptions,
  MetricDefinitionInput,
  SemanticComparisonResult,
} from "../types.js";
import {
  runIsolatedPostgresqlParser,
  type PostgresqlParserIsolationHarness,
} from "./postgresqlParserIsolation.js";

interface EnhancedStructureResult {
  structure: SqlStructureSummary;
  analysisLimitations: string[];
}

function enhancePostgresqlStructure(
  fallbackStructure: SqlStructureSummary,
  externalResult: ExternalSqlParseResult,
  queryLabel: "A" | "B",
): EnhancedStructureResult {
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

function analyzePostgresqlStructure(
  sql: string,
  queryLabel: "A" | "B",
): EnhancedStructureResult {
  return enhancePostgresqlStructure(
    analyzeSqlStructure(sql),
    nodeSqlPostgresqlParser.parse(sql),
    queryLabel,
  );
}

function compareEnhancedStructures(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  enhancedA: EnhancedStructureResult,
  enhancedB: EnhancedStructureResult,
): SemanticComparisonResult {
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

export function comparePostgresqlMetricDefinitions(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): SemanticComparisonResult {
  const enhancedA = analyzePostgresqlStructure(inputA.query, "A");
  const enhancedB = analyzePostgresqlStructure(inputB.query, "B");
  return compareEnhancedStructures(inputA, inputB, enhancedA, enhancedB);
}

export function comparePostgresqlSqlQueries(
  queryA: string,
  queryB: string,
): SemanticComparisonResult {
  return comparePostgresqlMetricDefinitions({ query: queryA }, { query: queryB });
}

export async function comparePostgresqlMetricDefinitionsIsolated(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  options: IsolatedPostgresqlComparisonOptions = {},
  isolationHarness?: PostgresqlParserIsolationHarness,
): Promise<SemanticComparisonResult> {
  const fallbackA = analyzeSqlStructure(inputA.query);
  const fallbackB = analyzeSqlStructure(inputB.query);
  const isolatedResult = await runIsolatedPostgresqlParser(
    [inputA.query, inputB.query],
    options,
    isolationHarness,
  );
  const externalResults: [ExternalSqlParseResult, ExternalSqlParseResult] =
    isolatedResult.ok
      ? isolatedResult.results
      : [
          {
            ok: false,
            dialect: "postgresql",
            reason: isolatedResult.reason,
          },
          {
            ok: false,
            dialect: "postgresql",
            reason: isolatedResult.reason,
          },
        ];

  return compareEnhancedStructures(
    inputA,
    inputB,
    enhancePostgresqlStructure(fallbackA, externalResults[0], "A"),
    enhancePostgresqlStructure(fallbackB, externalResults[1], "B"),
  );
}

export function comparePostgresqlSqlQueriesIsolated(
  queryA: string,
  queryB: string,
  options: IsolatedPostgresqlComparisonOptions = {},
  isolationHarness?: PostgresqlParserIsolationHarness,
): Promise<SemanticComparisonResult> {
  return comparePostgresqlMetricDefinitionsIsolated(
    { query: queryA },
    { query: queryB },
    options,
    isolationHarness,
  );
}
