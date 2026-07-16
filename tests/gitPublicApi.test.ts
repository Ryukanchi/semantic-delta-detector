import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as publicApi from "../src/index.js";
import {
  compareGitChanges,
  discoverGitChangedFiles,
  GitDiscoveryError,
  loadGitPairContent,
  type LoadGitPairContentOptions,
  type VerifiedGitCommitHash,
} from "../src/index.js";

type JavaScriptRunner = (args: readonly string[]) => {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
};

function git(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  assert.equal(
    result.status,
    0,
    `Git command failed (${args.join(" ")}): ${result.stderr || result.error?.message}`,
  );
  return result.stdout.trim();
}

function contentOptions(hash: string): LoadGitPairContentOptions {
  return {
    repositoryPath: process.cwd(),
    baseRef: hash as VerifiedGitCommitHash,
    headRef: hash as VerifiedGitCommitHash,
    pair: {
      beforePath: "README.md",
      afterPath: "README.md",
      displayPath: "README.md",
    },
  };
}

function createSpoofRunner(callCount: { value: number }): JavaScriptRunner {
  return () => {
    callCount.value += 1;
    return {
      status: 0,
      stdout: Buffer.from("commit\n"),
      stderr: Buffer.alloc(0),
    };
  };
}

test("public Git APIs expose options only and no runner implementation", () => {
  assert.equal(discoverGitChangedFiles.length, 1);
  assert.equal(loadGitPairContent.length, 1);
  assert.equal(compareGitChanges.length, 1);
  assert.equal("runGitCommand" in publicApi, false);
  assert.equal("discoverGitChangedFilesWithRunner" in publicApi, false);
  assert.equal("loadGitPairContentWithRunner" in publicApi, false);
  assert.equal("compareGitChangesWithRunner" in publicApi, false);
});

test("package exports block runner-enabled internal subpaths", async () => {
  const internalSubpath = [
    "semantic-delta-detector",
    "internal",
    "gitDiscoveryRuntime.js",
  ].join("/");

  await assert.rejects(
    () => import(internalSubpath),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});

test("public content loading ignores a JavaScript extra runner and rejects a tree", () => {
  const treeHash = git(["rev-parse", "HEAD^{tree}"]);
  const callCount = { value: 0 };
  const spoofRunner = createSpoofRunner(callCount);
  const invokeFromJavaScript = loadGitPairContent as unknown as (
    options: LoadGitPairContentOptions,
    runner: JavaScriptRunner,
  ) => unknown;

  assert.throws(
    () => invokeFromJavaScript(contentOptions(treeHash), spoofRunner),
    (error: unknown) =>
      error instanceof GitDiscoveryError && /Git reported "tree"/.test(error.message),
  );
  assert.equal(callCount.value, 0);
});

test("a runner property cannot affect public content loading", () => {
  const blobHash = git(["rev-parse", "HEAD:README.md"]);
  const callCount = { value: 0 };
  const options = {
    ...contentOptions(blobHash),
    runner: createSpoofRunner(callCount),
  };

  assert.throws(
    () => loadGitPairContent(options),
    (error: unknown) =>
      error instanceof GitDiscoveryError && /Git reported "blob"/.test(error.message),
  );
  assert.equal(callCount.value, 0);
});

test("public discovery and comparison ignore extra malicious runners", () => {
  const callCount = { value: 0 };
  const spoofRunner = createSpoofRunner(callCount);
  const options = {
    repositoryPath: process.cwd(),
    baseRef: `missing-public-ref-${process.pid}`,
    headRef: "HEAD",
    runner: spoofRunner,
  };
  const discoverFromJavaScript = discoverGitChangedFiles as unknown as (
    value: typeof options,
    runner: JavaScriptRunner,
  ) => unknown;
  const compareFromJavaScript = compareGitChanges as unknown as (
    value: typeof options,
    runner: JavaScriptRunner,
  ) => unknown;

  assert.throws(
    () => discoverFromJavaScript(options, spoofRunner),
    (error: unknown) =>
      error instanceof GitDiscoveryError && /Unknown base ref/.test(error.message),
  );
  assert.throws(
    () => compareFromJavaScript(options, spoofRunner),
    (error: unknown) =>
      error instanceof GitDiscoveryError && /Unknown base ref/.test(error.message),
  );
  assert.equal(callCount.value, 0);
});

test("public content loading rejects nonexistent objects and accepts commits", () => {
  assert.throws(
    () => loadGitPairContent(contentOptions("0".repeat(40))),
    (error: unknown) =>
      error instanceof GitDiscoveryError &&
      /Could not verify base commit hash/.test(error.message),
  );

  const commitHash = git(["rev-parse", "HEAD"]);
  const result = loadGitPairContent(contentOptions(commitHash));
  assert.equal(result.failures.length, 0);
  assert.match(result.beforeContent ?? "", /semantic-delta-detector/i);
  assert.equal(result.afterContent, result.beforeContent);
});
