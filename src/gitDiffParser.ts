import type { CandidateFile } from "./candidatePairing.js";

export type GitDiffFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "unknown";

export interface GitDiffChangedFile {
  status: GitDiffFileStatus;
  path: string;
  beforePath?: string;
  afterPath?: string;
  rawStatus: string;
}

export interface GitDiffParseSkippedLine {
  line: string;
  reason: string;
}

export interface GitDiffNameStatusParseResult {
  files: GitDiffChangedFile[];
  skipped: GitDiffParseSkippedLine[];
}

function skipLine(
  result: GitDiffNameStatusParseResult,
  line: string,
  reason: string,
): void {
  result.skipped.push({ line, reason });
}

function mapStatus(rawStatus: string): GitDiffFileStatus {
  if (rawStatus === "M") {
    return "modified";
  }

  if (rawStatus === "A") {
    return "added";
  }

  if (rawStatus === "D") {
    return "deleted";
  }

  if (rawStatus.startsWith("R")) {
    return "renamed";
  }

  return "unknown";
}

export function parseGitDiffNameStatus(output: string): GitDiffNameStatusParseResult {
  const result: GitDiffNameStatusParseResult = {
    files: [],
    skipped: [],
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0) {
      continue;
    }

    const fields = line.split("\t");
    if (fields.length < 2) {
      skipLine(result, line, "missing tab-separated status and path fields");
      continue;
    }

    const rawStatus = fields[0].trim();
    if (!rawStatus) {
      skipLine(result, line, "missing file status");
      continue;
    }

    const status = mapStatus(rawStatus);
    if (status === "renamed") {
      if (fields.length !== 3 || !fields[1] || !fields[2]) {
        skipLine(result, line, "renamed entry requires before and after paths");
        continue;
      }

      result.files.push({
        status,
        path: fields[2],
        beforePath: fields[1],
        afterPath: fields[2],
        rawStatus,
      });
      continue;
    }

    if (!fields[1]) {
      skipLine(result, line, "missing file path");
      continue;
    }

    if (fields.length !== 2) {
      skipLine(result, line, `${rawStatus} entry requires exactly one path`);
      continue;
    }

    result.files.push({
      status,
      path: fields[1],
      rawStatus,
    });
  }

  return result;
}

export function gitDiffFilesToCandidates(files: GitDiffChangedFile[]): CandidateFile[] {
  return files.map((file): CandidateFile => {
    if (file.status === "modified") {
      return {
        path: file.path,
        status: "modified",
        hasBefore: true,
        hasAfter: true,
      };
    }

    if (file.status === "added") {
      return {
        path: file.path,
        status: "added",
        hasBefore: false,
        hasAfter: true,
      };
    }

    if (file.status === "deleted") {
      return {
        path: file.path,
        status: "deleted",
        hasBefore: true,
        hasAfter: false,
      };
    }

    if (file.status === "renamed" && file.beforePath && file.afterPath) {
      return {
        path: file.afterPath,
        status: "renamed",
        beforePath: file.beforePath,
        afterPath: file.afterPath,
        hasBefore: true,
        hasAfter: true,
      };
    }

    return {
      path: file.path,
      status: "unknown",
      hasBefore: false,
      hasAfter: false,
    };
  });
}
