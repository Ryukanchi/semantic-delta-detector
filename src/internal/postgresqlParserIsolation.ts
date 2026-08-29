import { Worker, type WorkerOptions } from "node:worker_threads";
import type { IsolatedPostgresqlComparisonOptions } from "../types.js";
import type { ExternalSqlParseResult } from "../parser/externalSqlParser.js";
import { postgresqlParserResourceLimits } from "../parser/nodeSqlParserAdapter.js";
import type {
  SqlSetExpressionSummary,
  SqlSyntaxSummary,
  SqlWindowFrameSummary,
} from "../parser/sqlStructure.js";

const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_CHARACTERS = 8_000_000;

export const postgresqlParserIsolationDefaults = Object.freeze({
  timeoutMs: 2_000,
  resourceLimits: Object.freeze({
    maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 32,
    stackSizeMb: 4,
  }),
});

export type PostgresqlParserIsolationFailureKind =
  | "timeout"
  | "worker_error"
  | "unexpected_exit"
  | "protocol_error"
  | "startup_error"
  | "termination_error";

export interface PostgresqlParserIsolationSuccess {
  ok: true;
  results: [ExternalSqlParseResult, ExternalSqlParseResult];
}

export interface PostgresqlParserIsolationFailure {
  ok: false;
  kind: PostgresqlParserIsolationFailureKind;
  reason: string;
}

export type PostgresqlParserIsolationResult =
  | PostgresqlParserIsolationSuccess
  | PostgresqlParserIsolationFailure;

export interface PostgresqlParserIsolationHarness {
  workerFactory?: (workerUrl: URL, options: WorkerOptions) => Worker;
  onWorkerCreated?: (threadId: number) => void;
  onWorkerTerminated?: (threadId: number) => void;
}

interface ParsePairResponse {
  type: "postgresql_parse_pair_result";
  requestId: string;
  results: [ExternalSqlParseResult, ExternalSqlParseResult];
}

let requestSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isStringArray(value: unknown, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    value.every((item) => typeof item === "string")
  );
}

function isSetExpression(
  value: unknown,
  budget: { branches: number },
  depth = 0,
): value is SqlSetExpressionSummary {
  if (
    !isRecord(value) ||
    depth > postgresqlParserResourceLimits.maxAstDepth
  ) {
    return false;
  }

  if (value.kind === "query") {
    budget.branches += 1;
    if (budget.branches > postgresqlParserResourceLimits.maxSetOperationBranches) {
      return false;
    }
    return (
      Array.isArray(value.sources) &&
      value.sources.length <= postgresqlParserResourceLimits.maxSourceOccurrences &&
      value.sources.every(
        (source) =>
          isRecord(source) &&
          typeof source.name === "string" &&
          isNullableString(source.alias),
      )
    );
  }

  return (
    value.kind === "set_operation" &&
    ["union", "union_all", "intersect", "except"].includes(
      typeof value.operator === "string" ? value.operator : "",
    ) &&
    isSetExpression(value.left, budget, depth + 1) &&
    isSetExpression(value.right, budget, depth + 1)
  );
}

function isWindowFrame(value: unknown): value is SqlWindowFrameSummary | null {
  return (
    value === null ||
    (isRecord(value) &&
      ["rows", "range", "groups"].includes(
        typeof value.unit === "string" ? value.unit : "",
      ) &&
      typeof value.start === "string" &&
      isNullableString(value.end))
  );
}

function isSqlSyntaxSummary(value: unknown): value is SqlSyntaxSummary {
  if (!isRecord(value)) {
    return false;
  }

  const setExpressionValid =
    value.setExpression === null ||
    isSetExpression(value.setExpression, { branches: 0 });
  if (!setExpressionValid) {
    return false;
  }

  return (
    Array.isArray(value.windows) &&
    value.windows.length <= postgresqlParserResourceLimits.maxWindowExpressions &&
    value.windows.every(
      (window) =>
        isRecord(window) &&
        typeof window.functionName === "string" &&
        isStringArray(window.partitionBy, postgresqlParserResourceLimits.maxListItems) &&
        Array.isArray(window.orderBy) &&
        window.orderBy.length <= postgresqlParserResourceLimits.maxListItems &&
        window.orderBy.every(
          (ordering) =>
            isRecord(ordering) &&
            typeof ordering.expression === "string" &&
            (ordering.direction === null ||
              ordering.direction === "asc" ||
              ordering.direction === "desc") &&
            (ordering.nulls === null ||
              ordering.nulls === "first" ||
              ordering.nulls === "last"),
        ) &&
        isWindowFrame(window.frame),
    ) &&
    Array.isArray(value.sourceOccurrences) &&
    value.sourceOccurrences.length <=
      postgresqlParserResourceLimits.maxSourceOccurrences &&
    value.sourceOccurrences.every(
      (source) =>
        isRecord(source) &&
        typeof source.physicalName === "string" &&
        isNullableString(source.alias) &&
        typeof source.scopeId === "string",
    ) &&
    Array.isArray(value.joinEdges) &&
    value.joinEdges.length <= postgresqlParserResourceLimits.maxJoinEdges &&
    value.joinEdges.every(
      (edge) =>
        isRecord(edge) &&
        typeof edge.scopeId === "string" &&
        typeof edge.leftQualifier === "string" &&
        typeof edge.leftColumn === "string" &&
        typeof edge.operator === "string" &&
        typeof edge.rightQualifier === "string" &&
        typeof edge.rightColumn === "string",
    ) &&
    Array.isArray(value.sourceUsages) &&
    value.sourceUsages.length <= postgresqlParserResourceLimits.maxSourceUsages &&
    value.sourceUsages.every(
      (usage) =>
        isRecord(usage) &&
        typeof usage.scopeId === "string" &&
        isNullableString(usage.qualifier) &&
        typeof usage.column === "string" &&
        ["projection", "aggregation", "filter", "grouping", "having", "ordering"].includes(
          typeof usage.context === "string" ? usage.context : "",
        ) &&
        isNullableString(usage.functionName) &&
        typeof usage.distinct === "boolean",
    ) &&
    typeof value.sourceGraphComplete === "boolean"
  );
}

function isExternalParseResult(value: unknown): value is ExternalSqlParseResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok) {
    return isSqlSyntaxSummary(value.syntax);
  }
  return (
    value.dialect === "postgresql" &&
    typeof value.reason === "string" &&
    value.reason.length > 0
  );
}

function decodeResponse(message: unknown, requestId: string): ParsePairResponse {
  if (typeof message !== "string") {
    throw new Error("Worker response was not a serialized JSON message");
  }
  if (message.length > MAX_RESPONSE_CHARACTERS) {
    throw new Error("Worker response exceeded the communication resource limit");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(message) as unknown;
  } catch {
    throw new Error("Worker response was not valid JSON");
  }

  if (
    !isRecord(decoded) ||
    decoded.type !== "postgresql_parse_pair_result" ||
    decoded.requestId !== requestId ||
    !Array.isArray(decoded.results) ||
    decoded.results.length !== 2 ||
    !decoded.results.every(isExternalParseResult)
  ) {
    throw new Error("Worker response contained an invalid parser result");
  }

  return {
    type: decoded.type,
    requestId: decoded.requestId,
    results: [decoded.results[0], decoded.results[1]],
  };
}

function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown Worker failure";
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function readTimeoutMs(options: IsolatedPostgresqlComparisonOptions): number {
  const timeoutMs = options.timeoutMs ?? postgresqlParserIsolationDefaults.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`PostgreSQL parser timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function getWorkerUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./postgresqlParserWorker.${extension}`, import.meta.url);
}

function createRequestId(): string {
  requestSequence += 1;
  return `${process.pid}-${Date.now()}-${requestSequence}`;
}

function callLifecycleHook(hook: ((threadId: number) => void) | undefined, threadId: number): void {
  try {
    hook?.(threadId);
  } catch {
    // Test-only observations must never change production lifecycle behavior.
  }
}

export async function runIsolatedPostgresqlParser(
  queries: readonly [string, string],
  options: IsolatedPostgresqlComparisonOptions = {},
  harness: PostgresqlParserIsolationHarness = {},
): Promise<PostgresqlParserIsolationResult> {
  const timeoutMs = readTimeoutMs(options);
  const requestId = createRequestId();
  const startedAt = Date.now();
  const workerOptions: WorkerOptions = {
    resourceLimits: postgresqlParserIsolationDefaults.resourceLimits,
  };

  let worker: Worker;
  try {
    worker = harness.workerFactory
      ? harness.workerFactory(getWorkerUrl(), workerOptions)
      : new Worker(getWorkerUrl(), workerOptions);
  } catch (error) {
    return {
      ok: false,
      kind: "startup_error",
      reason: `isolated PostgreSQL parser Worker could not start (${formatErrorMessage(error)})`,
    };
  }

  const threadId = worker.threadId;
  callLifecycleHook(harness.onWorkerCreated, threadId);

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const removeListeners = (): void => {
      worker.removeAllListeners("message");
      worker.removeAllListeners("messageerror");
      worker.removeAllListeners("error");
      worker.removeAllListeners("exit");
    };

    const finish = (
      result: PostgresqlParserIsolationResult,
      terminate: boolean,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      removeListeners();

      void (async () => {
        let finalResult = result;
        if (terminate) {
          try {
            await worker.terminate();
          } catch (error) {
            finalResult = {
              ok: false,
              kind: "termination_error",
              reason: `isolated PostgreSQL parser Worker termination could not be confirmed after ${
                result.ok ? "a parser result" : result.reason
              } (${formatErrorMessage(error)})`,
            };
          }
        }
        callLifecycleHook(harness.onWorkerTerminated, threadId);
        resolve(finalResult);
      })();
    };

    worker.on("message", (message: unknown) => {
      try {
        const response = decodeResponse(message, requestId);
        finish({ ok: true, results: response.results }, true);
      } catch (error) {
        finish(
          {
            ok: false,
            kind: "protocol_error",
            reason: `isolated PostgreSQL parser communication failed (${formatErrorMessage(error)})`,
          },
          true,
        );
      }
    });
    worker.on("messageerror", (error: Error) => {
      finish(
        {
          ok: false,
          kind: "protocol_error",
          reason: `isolated PostgreSQL parser response could not be deserialized (${formatErrorMessage(error)})`,
        },
        true,
      );
    });
    worker.on("error", (error: Error) => {
      finish(
        {
          ok: false,
          kind: "worker_error",
          reason: `isolated PostgreSQL parser Worker failed (${formatErrorMessage(error)})`,
        },
        true,
      );
    });
    worker.on("exit", (code: number) => {
      finish(
        {
          ok: false,
          kind: "unexpected_exit",
          reason: `isolated PostgreSQL parser Worker exited unexpectedly with code ${code}`,
        },
        false,
      );
    });

    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
    timer = setTimeout(() => {
      finish(
        {
          ok: false,
          kind: "timeout",
          reason: `isolated PostgreSQL parser timed out after ${timeoutMs} ms`,
        },
        true,
      );
    }, remainingMs);

    try {
      worker.postMessage({
        type: "postgresql_parse_pair",
        requestId,
        queries: [queries[0], queries[1]],
      });
    } catch (error) {
      finish(
        {
          ok: false,
          kind: "protocol_error",
          reason: `isolated PostgreSQL parser request could not be sent (${formatErrorMessage(error)})`,
        },
        true,
      );
    }
  });
}
