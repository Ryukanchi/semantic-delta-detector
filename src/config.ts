import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFailOnThreshold, SeverityThreshold } from "./ciGating.js";

export interface SemanticDeltaConfig {
  failOn?: SeverityThreshold;
}

const configFileName = "semantic-delta.yml";

function cleanScalarValue(value: string): string {
  return value
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

export function loadSemanticDeltaConfig(cwd = process.cwd()): SemanticDeltaConfig {
  const configPath = resolve(cwd, configFileName);

  if (!existsSync(configPath)) {
    return {};
  }

  const contents = readFileSync(configPath, "utf8");
  const failOnLine = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^fail_on\s*:/i.test(line));

  if (!failOnLine) {
    return {};
  }

  const value = cleanScalarValue(failOnLine.replace(/^fail_on\s*:/i, ""));
  if (!value) {
    return {};
  }

  try {
    return { failOn: parseFailOnThreshold(value) };
  } catch {
    throw new Error(
      `Invalid semantic-delta.yml fail_on value "${value}". Supported values: low, medium, high, critical.`,
    );
  }
}
