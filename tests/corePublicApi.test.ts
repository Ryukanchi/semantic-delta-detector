import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as coreApi from "../src/core.js";
import * as rootApi from "../src/index.js";
import * as postgresqlApi from "../src/postgresql.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "..");
const sourceRoot = resolve(projectRoot, "src");

const expectedRuntimeExports = [
  "buildImpactLayer",
  "buildVerdict",
  "compareMetricDefinitions",
  "compareSqlQueries",
] as const;

const expectedPostgresqlRuntimeExports = [
  ...expectedRuntimeExports,
  "compareMetricDefinitionsIsolated",
  "compareSqlQueriesIsolated",
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

test("the PostgreSQL opt-in entrypoint preserves sync APIs and adds isolated APIs", () => {
  assert.deepEqual(
    Object.keys(postgresqlApi).sort(),
    [...expectedPostgresqlRuntimeExports].sort(),
  );
  for (const exportName of expectedPostgresqlRuntimeExports) {
    assert.equal(typeof postgresqlApi[exportName], "function");
  }
  assert.notEqual(postgresqlApi.compareSqlQueries, coreApi.compareSqlQueries);
  assert.equal("compareSqlQueriesIsolated" in coreApi, false);
  assert.equal("compareSqlQueriesIsolated" in rootApi, false);
  assert.equal(
    postgresqlApi.compareSqlQueries(
      "SELECT COUNT(*) FROM users",
      "SELECT COUNT(*) FROM users",
    ) instanceof Promise,
    false,
  );
});

test("package metadata exposes the core runtime and declarations", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8"),
  ) as {
    version?: string;
    exports: Record<string, { types: string; import: string }>;
    files?: string[];
    repository?: { type: string; url: string };
    homepage?: string;
    bugs?: { url: string };
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.version, "1.0.2");

  assert.deepEqual(packageJson.exports["./core"], {
    types: "./dist/core.d.ts",
    import: "./dist/core.js",
  });
  assert.deepEqual(packageJson.exports["./postgresql"], {
    types: "./dist/postgresql.d.ts",
    import: "./dist/postgresql.js",
  });
  assert.deepEqual(packageJson.files, [
    "CHANGELOG.md",
    "dist",
    "docs/assets/*.png",
    "docs/design/git-discovery.md",
    "docs/design/postgresql-hybrid.md",
  ]);
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/Ryukanchi/semantic-delta-detector.git",
  });
  assert.equal(
    packageJson.homepage,
    "https://github.com/Ryukanchi/semantic-delta-detector#readme",
  );
  assert.deepEqual(packageJson.bugs, {
    url: "https://github.com/Ryukanchi/semantic-delta-detector/issues",
  });
  assert.equal(
    packageJson.scripts?.example,
    "tsx src/cli.ts --example unique-login-users-vs-login-event-rows",
  );
  assert.equal(
    fileURLToPath(import.meta.resolve("semantic-delta-detector/core")),
    resolve(projectRoot, "dist/core.js"),
  );
  assert.equal(
    fileURLToPath(import.meta.resolve("semantic-delta-detector/postgresql")),
    resolve(projectRoot, "dist/postgresql.js"),
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

test("package exports block PostgreSQL adapter internals", async () => {
  await assert.rejects(
    import("semantic-delta-detector/parser/nodeSqlParserAdapter"),
    /Package subpath .* is not defined by "exports"/,
  );
  await assert.rejects(
    import("semantic-delta-detector/internal/enhancedSqlComparisonRuntime"),
    /Package subpath .* is not defined by "exports"/,
  );
  await assert.rejects(
    import("semantic-delta-detector/internal/postgresqlParserIsolation"),
    /Package subpath .* is not defined by "exports"/,
  );
  await assert.rejects(
    import("semantic-delta-detector/internal/postgresqlParserWorker"),
    /Package subpath .* is not defined by "exports"/,
  );
});

test("public API preserves SeverityThreshold source compatibility", () => {
  type AssertCompatible<T extends rootApi.GitComparisonSummary["highestSeverity"]> = T;
  const criticalValue: AssertCompatible<"critical"> = "critical";
  const highValue: AssertCompatible<"high"> = "high";
  const mediumValue: AssertCompatible<"medium"> = "medium";
  const lowValue: AssertCompatible<"low"> = "low";

  assert.equal(criticalValue, "critical");
  assert.equal(highValue, "high");
  assert.equal(mediumValue, "medium");
  assert.equal(lowValue, "low");
});
