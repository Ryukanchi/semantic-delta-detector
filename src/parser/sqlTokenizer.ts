import { ParsedSqlQuery, SqlJoinClause } from "../types.js";

const AGGREGATION_PATTERNS = ["count", "sum", "avg", "min", "max"];

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function cleanToken(input: string): string {
  return normalizeWhitespace(input).replace(/;+$/g, "").trim();
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((item) => cleanToken(item)).filter(Boolean))];
}

function normalizeIdentifier(input: string): string {
  return cleanToken(input)
    .replace(/^distinct\s+/i, "")
    .replace(/^[a-zA-Z_][a-zA-Z0-9_]*\./, "")
    .replace(/"/g, "");
}

function splitConditions(whereClause: string | null): string[] {
  if (!whereClause) {
    return [];
  }

  return dedupe(
    whereClause
      .split(/\bAND\b|\bOR\b/i)
      .map((part) => cleanToken(part))
      .filter(Boolean),
  );
}

function extractTables(query: string): string[] {
  const matches = [...query.matchAll(/\b(?:from|join)\s+([a-zA-Z0-9_."]+)/gi)];
  return dedupe(matches.map((match) => match[1].replace(/"/g, "")));
}

function normalizeJoinType(input: string | undefined): SqlJoinClause["type"] {
  const normalized = (input || "inner").trim().toLowerCase();

  if (normalized.startsWith("left")) {
    return "left";
  }

  if (normalized.startsWith("right")) {
    return "right";
  }

  if (normalized.startsWith("full")) {
    return "full";
  }

  if (normalized.startsWith("cross")) {
    return "cross";
  }

  return "inner";
}

function extractJoinClauses(query: string): SqlJoinClause[] {
  const matches = [
    ...query.matchAll(
      /\b(?:(left|right|full|inner|cross)(?:\s+outer)?\s+)?join\s+([a-zA-Z0-9_."]+)/gi,
    ),
  ];

  return matches.map((match) => ({
    type: normalizeJoinType(match[1]),
    table: match[2].replace(/"/g, ""),
  }));
}

function extractSelectExpressions(query: string): string[] {
  const match = query.match(/\bselect\s+(.+?)\s+\bfrom\b/is);
  if (!match) {
    return [];
  }

  return dedupe(
    match[1]
      .split(",")
      .map((part) => normalizeWhitespace(part))
      .filter(Boolean),
  );
}

function extractAggregation(expressions: string[]): {
  aggregation: string | null;
  aggregationDistinctTarget: string | null;
} {
  for (const expression of expressions) {
    for (const fn of AGGREGATION_PATTERNS) {
      const pattern = new RegExp(`\\b${fn}\\s*\\((.*?)\\)`, "i");
      const match = expression.match(pattern);
      if (!match) {
        continue;
      }

      const inner = normalizeWhitespace(match[1]);
      const distinctMatch = inner.match(/^distinct\s+(.+)$/i);

      return {
        aggregation: fn,
        aggregationDistinctTarget: distinctMatch
          ? normalizeIdentifier(distinctMatch[1])
          : normalizeIdentifier(inner),
      };
    }
  }

  return {
    aggregation: null,
    aggregationDistinctTarget: null,
  };
}

function extractWhereClause(query: string): string | null {
  const match = query.match(
    /\bwhere\b\s+(.+?)(?=\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|$)/is,
  );

  return match ? normalizeWhitespace(match[1]) : null;
}

function extractGroupByExpressions(query: string): string[] {
  const match = query.match(
    /\bgroup\s+by\b\s+(.+?)(?=\border\s+by\b|\bhaving\b|\blimit\b|$)/is,
  );
  if (!match) {
    return [];
  }

  return dedupe(
    match[1]
      .split(",")
      .map((part) => normalizeWhitespace(part))
      .filter(Boolean),
  );
}

function extractTimeWindows(conditions: string[]): string[] {
  return dedupe(
    conditions.filter((condition) =>
      /(current_date|current_timestamp|interval|dateadd|datediff|\d+\s+day|\d+\s+month|\d+\s+year|last_active|event_date|created_at)/i.test(
        condition,
      ),
    ),
  );
}

function extractFilters(conditions: string[]): string[] {
  return dedupe(
    conditions.filter(
      (condition) =>
        !/(current_date|current_timestamp|interval|dateadd|datediff)/i.test(condition),
    ),
  );
}

function inferMetricName(query: string, tables: string[], conditions: string[]): string {
  const selectClause = query.match(/\bselect\s+(.+?)\s+\bfrom\b/is)?.[1] ?? "";
  const aliases = [...selectClause.matchAll(/\bas\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)];
  if (aliases.length > 0) {
    return aliases[aliases.length - 1][1];
  }

  const eventCondition = conditions.find((condition) => /\bevent\s*=\s*/i.test(condition));
  if (eventCondition) {
    const eventName = eventCondition.match(/'([^']+)'/);
    if (eventName) {
      return `${eventName[1]}_users`;
    }
  }

  const statusCondition = conditions.find((condition) => /\bstatus\b/i.test(condition));
  if (statusCondition) {
    const statusName = statusCondition.match(/'([^']+)'/);
    if (statusName) {
      return `${statusName[1]}_users`;
    }
  }

  const quotedValue = conditions
    .filter((condition) => !/(current_date|current_timestamp|interval|dateadd|datediff)/i.test(condition))
    .map((condition) => condition.match(/'([^']+)'/))
    .find((match) => Boolean(match?.[1]));
  if (quotedValue?.[1]) {
    return `${quotedValue[1]}_metric`;
  }

  if (tables.length > 0) {
    return `${tables[0]}_metric`;
  }

  return "derived_metric";
}

export function tokenizeSql(rawQuery: string): ParsedSqlQuery {
  const normalizedQuery = normalizeWhitespace(rawQuery);
  const tables = extractTables(normalizedQuery);
  const joinClauses = extractJoinClauses(normalizedQuery);
  const selectedExpressions = extractSelectExpressions(normalizedQuery);
  const { aggregation, aggregationDistinctTarget } = extractAggregation(selectedExpressions);
  const whereClause = extractWhereClause(normalizedQuery);
  const groupByExpressions = extractGroupByExpressions(normalizedQuery);
  const conditions = splitConditions(whereClause);
  const timeWindows = extractTimeWindows(conditions);
  const filters = extractFilters(conditions);
  const metricName = inferMetricName(normalizedQuery, tables, conditions);

  return {
    rawQuery,
    normalizedQuery,
    tables,
    selectedExpressions,
    aggregation,
    aggregationDistinctTarget,
    metricName,
    whereClause,
    groupByExpressions,
    joinClauses,
    filters,
    timeWindows,
    conditions,
  };
}
