import type { SqlSyntaxSummary } from "./sqlStructure.js";

export type SqlDialect = "postgresql";

export interface ExternalSqlParseSuccess {
  ok: true;
  syntax: SqlSyntaxSummary;
}

export interface ExternalSqlParseFailure {
  ok: false;
  dialect: SqlDialect;
  reason: string;
}

export type ExternalSqlParseResult = ExternalSqlParseSuccess | ExternalSqlParseFailure;

export interface ExternalSqlParser {
  readonly dialect: SqlDialect;
  parse(sql: string): ExternalSqlParseResult;
}
