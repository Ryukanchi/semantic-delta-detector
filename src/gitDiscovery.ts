import type { CandidateFile, CandidatePair } from "./candidatePairing.js";
import type {
  GitDiffChangedFile,
  GitDiffParseSkippedLine,
} from "./gitDiffParser.js";
import { GitDiscoveryError } from "./gitDiscoveryError.js";
import {
  discoverGitChangedFilesWithRunner,
  loadGitPairContentWithRunner,
  runGitCommand,
} from "./internal/gitDiscoveryRuntime.js";

/** Full Git commit ID produced after verification; loaders reverify it per repository. */
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
  /** Full commit hash; reverified in repositoryPath before content loading. */
  baseRef: VerifiedGitCommitHash;
  /** Full commit hash; reverified in repositoryPath before content loading. */
  headRef: VerifiedGitCommitHash;
  pair: CandidatePair;
}

export { GitDiscoveryError };

export function discoverGitChangedFiles(
  options: GitDiscoveryOptions,
): GitDiscoveryResult {
  return discoverGitChangedFilesWithRunner(options, runGitCommand);
}

export function loadGitPairContent(
  options: LoadGitPairContentOptions,
): GitPairContentResult {
  return loadGitPairContentWithRunner(options, runGitCommand);
}
