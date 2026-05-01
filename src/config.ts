import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFailOnThreshold, SeverityThreshold } from "./ciGating.js";

export interface SemanticDeltaConfig {
  failOn?: SeverityThreshold;
  defaultBeforePath?: string;
  defaultAfterPath?: string;
  include: string[];
  ignore: string[];
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
    return { include: [], ignore: [] };
  }

  const contents = readFileSync(configPath, "utf8");
  const config: SemanticDeltaConfig = { include: [], ignore: [] };
  let activeList: "include" | "ignore" | null = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const listItemMatch = line.match(/^-\s+(.+)$/);
    if (activeList && listItemMatch) {
      const value = cleanScalarValue(listItemMatch[1]);
      if (value) {
        config[activeList].push(value);
      }
      continue;
    }

    const match = line.match(
      /^(fail_on|default_before_path|default_after_path|include|ignore)\s*:(.*)$/i,
    );
    if (!match) {
      activeList = null;
      continue;
    }

    const key = match[1].toLowerCase();
    const value = cleanScalarValue(match[2]);

    if (key === "include" || key === "ignore") {
      activeList = key;
      if (value) {
        config[key].push(value);
      }
      continue;
    }

    activeList = null;

    if (!value) {
      continue;
    }

    if (key === "fail_on") {
      try {
        config.failOn = parseFailOnThreshold(value);
      } catch {
        throw new Error(
          `Invalid semantic-delta.yml fail_on value "${value}". Supported values: low, medium, high, critical.`,
        );
      }
    } else if (key === "default_before_path") {
      config.defaultBeforePath = value;
    } else if (key === "default_after_path") {
      config.defaultAfterPath = value;
    }
  }

  return config;
}
