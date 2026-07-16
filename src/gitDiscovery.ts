import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CandidateFile, CandidatePair } from "./candidatePairing.js";
import {
  gitDiffFilesToCandidates,
  parseGitDiffNameStatus,
  type GitDiffChangedFile,
  type GitDiffParseSkippedLine,
} from "./gitDiffParser.js";

export interface GitCommandResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: Error;
}

export type GitCommandRunner = (args: readonly string[]) => GitCommandResult;

export type VerifiedGitCommitHash = string & {
  readonly __verifiedGitCommitHash: unique symbol;
};

export interface GitDiscoveryOptions {
  repositoryPath: string;
  baseRef: string;
  headRef: string;
}

export interface GitDiscoveryResult {
  repositoryPath: string;
  baseRef: string;
  headRef: string;
  resolvedBaseRef: VerifiedGitCommitHash;
  resolvedHeadRef: VerifiedGitCommitHash;
  files: GitDiffChangedFile[];
  candidates: CandidateFile[];
  parserSkipped: GitDiffParseSkippedLine[];
  warnings: string[];
}

export interface GitContentLoadFailure {
  side: "before" | "after";
  ref: string;
  path: string;
  reason: string;
}

export interface GitPairContentResult {
  pair: CandidatePair;
  beforeContent?: string;
  afterContent?: string;
  failures: GitContentLoadFailure[];
  warnings: string[];
}

export interface LoadGitPairContentOptions {
  repositoryPath: string;
  /** Full commit hash returned by verified Git ref resolution. */
  baseRef: VerifiedGitCommitHash;
  /** Full commit hash returned by verified Git ref resolution. */
  headRef: VerifiedGitCommitHash;
  pair: CandidatePair;
}

export class GitDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiscoveryError";
  }
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const fullGitCommitHashPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export const runGitCommand: GitCommandRunner = (args) => {
  const result = spawnSync("git", [...args], {
    encoding: null,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    ...(result.error ? { error: result.error } : {}),
  };
};

function decodeUtf8(buffer: Buffer, label: string): string {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    throw new GitDiscoveryError(`${label} was not valid UTF-8.`);
  }
}

function isFullGitCommitHash(value: unknown): value is VerifiedGitCommitHash {
  return typeof value === "string" && fullGitCommitHashPattern.test(value);
}

function requireVerifiedGitCommitHash(
  value: unknown,
  label: "base" | "head",
): VerifiedGitCommitHash {
  if (!isFullGitCommitHash(value)) {
    const invalidValue =
      typeof value === "string" ? `"${value}"` : `of type ${typeof value}`;
    throw new GitDiscoveryError(
      `Invalid ${label} commit hash ${invalidValue}. Git content loading requires a full 40- or 64-character hexadecimal commit hash produced by verified ref resolution.`,
    );
  }

  return value;
}

function formatFailure(result: GitCommandResult): string {
  const stderr = result.stderr.toString("utf8").trim();
  if (stderr) {
    return stderr;
  }

  if (result.error) {
    return result.error.message;
  }

  if (result.status === null) {
    return "Git process did not return an exit code.";
  }

  return `Git exited with code ${result.status}.`;
}

function runRequiredGitCommand(
  runner: GitCommandRunner,
  args: readonly string[],
  failurePrefix: string,
): { stdout: Buffer; warning?: string } {
  const result = runner(args);
  if (result.error || result.status !== 0) {
    throw new GitDiscoveryError(`${failurePrefix}: ${formatFailure(result)}`);
  }

  const warning = result.stderr.toString("utf8").trim();
  return {
    stdout: result.stdout,
    ...(warning ? { warning } : {}),
  };
}

function validateRepositoryPath(repositoryPath: string): string {
  const resolvedPath = resolve(repositoryPath);
  if (!existsSync(resolvedPath)) {
    throw new GitDiscoveryError(`Repository path does not exist: ${repositoryPath}`);
  }

  try {
    if (!statSync(resolvedPath).isDirectory()) {
      throw new GitDiscoveryError(`Repository path is not a directory: ${repositoryPath}`);
    }
  } catch (error) {
    if (error instanceof GitDiscoveryError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "unknown filesystem error";
    throw new GitDiscoveryError(`Could not inspect repository path ${repositoryPath}: ${message}`);
  }

  return resolvedPath;
}

function resolveCommitRef(
  runner: GitCommandRunner,
  repositoryPath: string,
  ref: string,
  label: "base" | "head",
  warnings: string[],
): VerifiedGitCommitHash {
  const result = runRequiredGitCommand(
    runner,
    [
      "-C",
      repositoryPath,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ],
    `Unknown ${label} ref "${ref}"`,
  );
  if (result.warning) {
    warnings.push(`Resolving ${label} ref produced stderr: ${result.warning}`);
  }

  const commit = decodeUtf8(result.stdout, `Resolved ${label} ref`).trim();
  if (!isFullGitCommitHash(commit)) {
    throw new GitDiscoveryError(
      `Resolved ${label} ref "${ref}" did not produce a valid commit hash.`,
    );
  }

  return commit;
}

export function discoverGitChangedFiles(
  options: GitDiscoveryOptions,
  runner: GitCommandRunner = runGitCommand,
): GitDiscoveryResult {
  const repositoryPath = validateRepositoryPath(options.repositoryPath);
  const warnings: string[] = [];
  const repositoryCheck = runRequiredGitCommand(
    runner,
    ["-C", repositoryPath, "rev-parse", "--is-inside-work-tree"],
    `Path is not a Git repository (${repositoryPath})`,
  );
  if (repositoryCheck.warning) {
    warnings.push(`Repository check produced stderr: ${repositoryCheck.warning}`);
  }

  if (decodeUtf8(repositoryCheck.stdout, "Git repository check").trim() !== "true") {
    throw new GitDiscoveryError(`Path is not a Git work tree: ${repositoryPath}`);
  }

  const resolvedBaseRef = resolveCommitRef(
    runner,
    repositoryPath,
    options.baseRef,
    "base",
    warnings,
  );
  const resolvedHeadRef = resolveCommitRef(
    runner,
    repositoryPath,
    options.headRef,
    "head",
    warnings,
  );
  const diffResult = runRequiredGitCommand(
    runner,
    [
      "-C",
      repositoryPath,
      "diff",
      "--name-status",
      "--find-renames",
      resolvedBaseRef,
      resolvedHeadRef,
      "--",
    ],
    `Could not compare refs "${options.baseRef}" and "${options.headRef}"`,
  );
  if (diffResult.warning) {
    warnings.push(`Git diff produced stderr: ${diffResult.warning}`);
  }

  const parsed = parseGitDiffNameStatus(decodeUtf8(diffResult.stdout, "Git diff output"));

  return {
    repositoryPath,
    baseRef: options.baseRef,
    headRef: options.headRef,
    resolvedBaseRef,
    resolvedHeadRef,
    files: parsed.files,
    candidates: gitDiffFilesToCandidates(parsed.files),
    parserSkipped: parsed.skipped,
    warnings,
  };
}

function loadGitContentSide(
  runner: GitCommandRunner,
  repositoryPath: string,
  ref: VerifiedGitCommitHash,
  path: string,
  side: GitContentLoadFailure["side"],
): { content?: string; failure?: GitContentLoadFailure; warning?: string } {
  const result = runner([
    "-C",
    repositoryPath,
    "show",
    "--no-ext-diff",
    "--no-textconv",
    "--format=",
    `${ref}:${path}`,
    "--",
  ]);

  if (result.error || result.status !== 0) {
    return {
      failure: {
        side,
        ref,
        path,
        reason: formatFailure(result),
      },
    };
  }

  if (result.stdout.includes(0)) {
    return {
      failure: {
        side,
        ref,
        path,
        reason: "content contains NUL bytes and is not treated as text SQL",
      },
    };
  }

  let content: string;
  try {
    content = decodeUtf8(result.stdout, `${side} content for ${path}`);
  } catch (error) {
    return {
      failure: {
        side,
        ref,
        path,
        reason: error instanceof Error ? error.message : "content could not be decoded safely",
      },
    };
  }

  const warning = result.stderr.toString("utf8").trim();
  return {
    content,
    ...(warning ? { warning } : {}),
  };
}

export function loadGitPairContent(
  options: LoadGitPairContentOptions,
  runner: GitCommandRunner = runGitCommand,
): GitPairContentResult {
  const baseRef = requireVerifiedGitCommitHash(options.baseRef, "base");
  const headRef = requireVerifiedGitCommitHash(options.headRef, "head");
  const before = loadGitContentSide(
    runner,
    options.repositoryPath,
    baseRef,
    options.pair.beforePath,
    "before",
  );
  const after = loadGitContentSide(
    runner,
    options.repositoryPath,
    headRef,
    options.pair.afterPath,
    "after",
  );
  const failures = [before.failure, after.failure].filter(
    (failure): failure is GitContentLoadFailure => Boolean(failure),
  );
  const warnings = [
    before.warning
      ? `Reading before content for ${options.pair.beforePath} produced stderr: ${before.warning}`
      : undefined,
    after.warning
      ? `Reading after content for ${options.pair.afterPath} produced stderr: ${after.warning}`
      : undefined,
  ].filter((warning): warning is string => Boolean(warning));

  return {
    pair: options.pair,
    ...(before.content !== undefined ? { beforeContent: before.content } : {}),
    ...(after.content !== undefined ? { afterContent: after.content } : {}),
    failures,
    warnings,
  };
}
