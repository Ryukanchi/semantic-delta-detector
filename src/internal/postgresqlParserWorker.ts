import { parentPort } from "node:worker_threads";
import type { NodeSqlPostgresqlParserAdapter } from "../parser/nodeSqlParserAdapter.js";

interface ParsePairRequest {
  type: "postgresql_parse_pair";
  requestId: string;
  queries: [string, string];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequest(value: unknown): ParsePairRequest {
  if (
    !isRecord(value) ||
    value.type !== "postgresql_parse_pair" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    !Array.isArray(value.queries) ||
    value.queries.length !== 2 ||
    !value.queries.every((query) => typeof query === "string")
  ) {
    throw new Error("received an invalid PostgreSQL parser Worker request");
  }

  return {
    type: value.type,
    requestId: value.requestId,
    queries: [value.queries[0], value.queries[1]],
  };
}

const port = parentPort;
if (!port) {
  throw new Error("PostgreSQL parser Worker requires a parent message port");
}

const adapterExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const adapterModule = (await import(
  new URL(`../parser/nodeSqlParserAdapter.${adapterExtension}`, import.meta.url).href
)) as { nodeSqlPostgresqlParser: NodeSqlPostgresqlParserAdapter };

port.once("message", (message: unknown) => {
  const request = readRequest(message);
  const response = {
    type: "postgresql_parse_pair_result",
    requestId: request.requestId,
    results: [
      adapterModule.nodeSqlPostgresqlParser.parse(request.queries[0]),
      adapterModule.nodeSqlPostgresqlParser.parse(request.queries[1]),
    ],
  };

  port.postMessage(JSON.stringify(response));
  port.close();
});
