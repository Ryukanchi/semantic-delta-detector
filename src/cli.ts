#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { compareMetricDefinitions } from "./analyzer/differenceEngine.js";
import {
  getResultSeverity,
  parseFailOnThreshold,
  SeverityThreshold,
  shouldFailForRisk,
} from "./ciGating.js";
import { loadSemanticDeltaConfig } from "./config.js";
import { exampleQueryPairs } from "./examples/queryPairs.js";
import { formatPrComment } from "./output/formatPrComment.js";
import { formatDemoReport, formatReadableReport } from "./output/formatReport.js";
import { MetricDefinitionInput } from "./types.js";

interface CliOptions {
  queryA?: string;
  queryB?: string;
  fileA?: string;
  fileB?: string;
  beforeFile?: string;
  afterFile?: string;
  jsonA?: string;
  jsonB?: string;
  example?: string;
  failOn?: SeverityThreshold;
  format: "json" | "text";
  demo: boolean;
  pr: boolean;
}

function printHelp(): void {
  console.log(`semantic-delta-detector

Usage:
  pnpm compare --query-a "SELECT ..." --query-b "SELECT ..."
  pnpm compare --file-a ./query-a.sql --file-b ./query-b.sql
  pnpm compare --before ./examples/before.sql --after ./examples/after.sql --pr
  pnpm compare --example login-vs-paid

Options:
  --query-a     Inline SQL query A
  --query-b     Inline SQL query B
  --file-a      Path to SQL file A
  --file-b      Path to SQL file B
  --before      Path to the before SQL file for PR simulation
  --after       Path to the after SQL file for PR simulation
  --json-a      Path to JSON metric definition A
  --json-b      Path to JSON metric definition B
  --example     Run a bundled example
  --demo        Show high-impact demo output
  --pr          Show a short GitHub PR-style comment
  --fail-on     Fail with exit code 1 when result risk is at or above low | medium | high | critical
  --format      json | text (default: text)
  --help        Show this message
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { format: "text", demo: false, pr: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case "--query-a":
        options.queryA = next;
        index += 1;
        break;
      case "--query-b":
        options.queryB = next;
        index += 1;
        break;
      case "--file-a":
        options.fileA = next;
        index += 1;
        break;
      case "--file-b":
        options.fileB = next;
        index += 1;
        break;
      case "--before":
        if (!next || next.startsWith("--")) {
          throw new Error("Missing file path for --before.");
        }
        options.beforeFile = next;
        index += 1;
        break;
      case "--after":
        if (!next || next.startsWith("--")) {
          throw new Error("Missing file path for --after.");
        }
        options.afterFile = next;
        index += 1;
        break;
      case "--json-a":
        options.jsonA = next;
        index += 1;
        break;
      case "--json-b":
        options.jsonB = next;
        index += 1;
        break;
      case "--example":
        options.example = next;
        index += 1;
        break;
      case "--format":
        if (next === "json" || next === "text") {
          options.format = next;
        }
        index += 1;
        break;
      case "--demo":
        options.demo = true;
        break;
      case "--pr":
        options.pr = true;
        break;
      case "--fail-on":
        if (!next || next.startsWith("--")) {
          throw new Error("Missing threshold for --fail-on.");
        }
        options.failOn = parseFailOnThreshold(next);
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        break;
    }
  }

  return options;
}

function readSqlFromFile(filePath: string, label = "SQL"): string {
  const resolvedPath = resolve(process.cwd(), filePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`${label} file does not exist: ${filePath}`);
  }

  if (!statSync(resolvedPath).isFile()) {
    throw new Error(`${label} path is not a file: ${filePath}`);
  }

  return readFileSync(resolvedPath, "utf8").trim();
}

function readMetricDefinitionFromJson(filePath: string): MetricDefinitionInput {
  const fileContents = readFileSync(resolve(process.cwd(), filePath), "utf8");
  const parsed = JSON.parse(fileContents) as MetricDefinitionInput;

  if (!parsed?.query || typeof parsed.query !== "string") {
    throw new Error(`JSON input "${filePath}" must contain a string "query" field.`);
  }

  const optionalFields: Array<keyof MetricDefinitionInput> = [
    "metric_name",
    "description",
    "team_context",
    "intended_use",
  ];

  for (const field of optionalFields) {
    const value = parsed[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`JSON input "${filePath}" field "${field}" must be a string if provided.`);
    }
  }

  return parsed;
}

function resolveInputs(options: CliOptions): { inputA: MetricDefinitionInput; inputB: MetricDefinitionInput } {
  if (options.beforeFile || options.afterFile) {
    if (!options.beforeFile || !options.afterFile) {
      throw new Error("Provide both --before and --after for PR simulation.");
    }

    return {
      inputA: {
        query: readSqlFromFile(options.beforeFile, "Before"),
      },
      inputB: {
        query: readSqlFromFile(options.afterFile, "After"),
      },
    };
  }

  if (options.example) {
    const example = exampleQueryPairs.find((item) => item.id === options.example);
    if (!example) {
      throw new Error(
        `Unknown example "${options.example}". Available examples: ${exampleQueryPairs
          .map((item) => item.id)
          .join(", ")}`,
      );
    }

    return {
      inputA: {
        metric_name: example.queryAName,
        query: example.queryA,
      },
      inputB: {
        metric_name: example.queryBName,
        query: example.queryB,
      },
    };
  }

  const inputA =
    options.jsonA
      ? readMetricDefinitionFromJson(options.jsonA)
      : {
          query: options.queryA ?? (options.fileA ? readSqlFromFile(options.fileA, "Query A") : ""),
        };
  const inputB =
    options.jsonB
      ? readMetricDefinitionFromJson(options.jsonB)
      : {
          query: options.queryB ?? (options.fileB ? readSqlFromFile(options.fileB, "Query B") : ""),
        };

  if (!inputA.query || !inputB.query) {
    throw new Error(
      "Provide both inputs via --query-a/--query-b, --file-a/--file-b, --json-a/--json-b, or --example.",
    );
  }

  return { inputA, inputB };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const config = loadSemanticDeltaConfig();
    const failOn = options.failOn ?? config.failOn;
    const { inputA, inputB } = resolveInputs(options);
    const result = compareMetricDefinitions(inputA, inputB);

    if (options.format === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else if (options.pr) {
      console.log(formatPrComment(result));
    } else if (options.demo) {
      console.log(formatDemoReport(result));
    } else {
      console.log(formatReadableReport(result, inputA.query, inputB.query));
      console.log("");
      console.log("JSON Output");
      console.log("-----------");
      console.log(JSON.stringify(result, null, 2));
    }

    if (failOn && shouldFailForRisk(getResultSeverity(result), failOn)) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI failure.";
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
