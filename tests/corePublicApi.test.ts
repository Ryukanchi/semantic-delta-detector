import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as coreApi from "../src/core.js";
import * as rootApi from "../src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const sourceRoot = resolve(projectRoot, "src");

const expectedRuntimeExports = [
  "buildImpactLayer",
  "buildVerdict",
  "compareMetricDefinitions",
  "compareSqlQueries",
] as const;

const forbiddenGitExports = [
  "compareGitChanges",
  "discoverGitChangedFiles",
  "GitDiscoveryError",
  "gitDiffFilesToCandidates",
  "loadGitPairContent",
  "parseGitDiffNameStatus",
] as const;

interface SourceDependencyGraph {
  modules: Set<string>;
  externalSpecifiers: Set<string>;
}

function resolveSourceModule(importingFile: string, specifier: string): string {
  const resolvedSpecifier = resolve(dirname(importingFile), specifier);
  return resolvedSpecifier.endsWith(".js")
    ? `${resolvedSpecifier.slice(0, -3)}.ts`
    : resolvedSpecifier;
}

function collectSourceDependencyGraph(entryPath: string): SourceDependencyGraph {
  const graph: SourceDependencyGraph = {
    modules: new Set<string>(),
    externalSpecifiers: new Set<string>(),
  };

  function visit(modulePath: string): void {
    if (graph.modules.has(modulePath)) {
      return;
    }

    graph.modules.add(modulePath);
    const source = readFileSync(modulePath, "utf8");
    const importPatterns = [
      /\bfrom\s+["']([^"']+)["']/g,
      /\bimport\s+["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];

    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) {
          graph.externalSpecifiers.add(specifier);
          continue;
        }

        const dependencyPath = resolveSourceModule(modulePath, specifier);
        assert.ok(
          existsSync(dependencyPath),
          `Could not resolve ${specifier} from ${relative(projectRoot, modulePath)}`,
        );
        visit(dependencyPath);
      }
    }
  }

  visit(entryPath);
  return graph;
}

test("core exposes only the browser-safe semantic runtime API", () => {
  assert.deepEqual(Object.keys(coreApi).sort(), [...expectedRuntimeExports].sort());

  for (const exportName of expectedRuntimeExports) {
    assert.equal(typeof coreApi[exportName], "function");
    assert.equal(coreApi[exportName], rootApi[exportName]);
  }

  for (const exportName of forbiddenGitExports) {
    assert.equal(exportName in coreApi, false);
    assert.equal(exportName in rootApi, true);
  }

  const result = coreApi.compareSqlQueries(
    "SELECT COUNT(*) FROM users",
    "SELECT COUNT(*) FROM users",
  );
  assert.equal(result.risk_level, "low");
});

test("package metadata exposes the core runtime and declarations", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8"),
  ) as {
    exports: Record<string, { types: string; import: string }>;
  };

  assert.deepEqual(packageJson.exports["./core"], {
    types: "./dist/core.d.ts",
    import: "./dist/core.js",
  });
  assert.deepEqual(packageJson.exports["./postgresql"], {
    types: "./dist/postgresql.d.ts",
    import: "./dist/postgresql.js",
  });
  assert.equal(
    fileURLToPath(import.meta.resolve("semantic-delta-detector/core")),
    resolve(projectRoot, "dist/core.js"),
  );
});

test("core dependency graph excludes Node built-ins and Git runtime modules", () => {
  const graph = collectSourceDependencyGraph(resolve(sourceRoot, "core.ts"));
  const modulePaths = [...graph.modules].map((modulePath) =>
    relative(sourceRoot, modulePath).split(sep).join("/"),
  );

  assert.deepEqual([...graph.externalSpecifiers], []);
  assert.ok(modulePaths.includes("analyzer/differenceEngine.ts"));
  assert.equal(modulePaths.includes("parser/nodeSqlParserAdapter.ts"), false);
  assert.equal(modulePaths.includes("internal/enhancedSqlComparisonRuntime.ts"), false);

  for (const modulePath of modulePaths) {
    assert.doesNotMatch(
      modulePath,
      /^(?:git(?:Comparison|DiffParser|Discovery|DiscoveryError)\.ts|internal\/git)/,
    );
  }
});
