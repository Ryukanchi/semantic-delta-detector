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

interface NulField {
  bytes: Buffer;
  terminated: boolean;
  nextOffset: number;
}

function readNulField(output: Buffer, offset: number): NulField | undefined {
  if (offset >= output.length) {
    return undefined;
  }

  const terminatorOffset = output.indexOf(0, offset);
  if (terminatorOffset === -1) {
    return {
      bytes: output.subarray(offset),
      terminated: false,
      nextOffset: output.length,
    };
  }

  return {
    bytes: output.subarray(offset, terminatorOffset),
    terminated: true,
    nextOffset: terminatorOffset + 1,
  };
}

function decodeNulField(field: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(field);
  } catch {
    return undefined;
  }
}

function formatNulFields(fields: Buffer[]): string {
  return fields
    .map((field) => {
      const decoded = decodeNulField(field);
      return decoded === undefined ? `0x${field.toString("hex")}` : JSON.stringify(decoded);
    })
    .join(" NUL ");
}

function skipNulRecord(
  result: GitDiffNameStatusParseResult,
  fields: Buffer[],
  reason: string,
): void {
  skipLine(result, formatNulFields(fields), reason);
}

/**
 * Parses `git diff --name-status -z` output without first converting the full
 * byte stream to text. This is intentionally not re-exported from the package
 * entry point; Git discovery owns the byte-oriented subprocess boundary.
 */
export function parseGitDiffNameStatusZ(
  output: Buffer,
): GitDiffNameStatusParseResult {
  const result: GitDiffNameStatusParseResult = {
    files: [],
    skipped: [],
  };
  let offset = 0;

  while (offset < output.length) {
    const statusField = readNulField(output, offset);
    if (!statusField) {
      break;
    }
    offset = statusField.nextOffset;
    const recordFields = [statusField.bytes];

    if (!statusField.terminated) {
      skipNulRecord(result, recordFields, "file status field is not NUL-terminated");
      break;
    }

    const rawStatus = decodeNulField(statusField.bytes);
    if (rawStatus === undefined) {
      skipNulRecord(result, recordFields, "file status field is not valid UTF-8");
      continue;
    }
    if (!rawStatus) {
      skipNulRecord(result, recordFields, "missing file status");
      continue;
    }

    const pathFieldCount =
      rawStatus.startsWith("R") || rawStatus.startsWith("C") ? 2 : 1;
    const pathFields: NulField[] = [];
    let incompleteReason: string | undefined;

    for (let pathIndex = 0; pathIndex < pathFieldCount; pathIndex += 1) {
      const pathField = readNulField(output, offset);
      if (!pathField) {
        incompleteReason =
          pathFieldCount === 2
            ? `${rawStatus} entry requires before and after paths`
            : `${rawStatus} entry requires exactly one path`;
        break;
      }

      pathFields.push(pathField);
      recordFields.push(pathField.bytes);
      offset = pathField.nextOffset;
      if (!pathField.terminated) {
        incompleteReason = `path field ${pathIndex + 1} is not NUL-terminated`;
        break;
      }
    }

    if (incompleteReason) {
      skipNulRecord(result, recordFields, incompleteReason);
      continue;
    }

    const decodedPaths = pathFields.map((field) => decodeNulField(field.bytes));
    const invalidPathIndex = decodedPaths.findIndex((path) => path === undefined);
    if (invalidPathIndex !== -1) {
      skipNulRecord(
        result,
        recordFields,
        `path field ${invalidPathIndex + 1} is not valid UTF-8`,
      );
      continue;
    }

    const paths = decodedPaths as string[];
    const emptyPathIndex = paths.findIndex((path) => path.length === 0);
    if (emptyPathIndex !== -1) {
      skipNulRecord(result, recordFields, `path field ${emptyPathIndex + 1} is empty`);
      continue;
    }

    if (rawStatus.startsWith("R")) {
      result.files.push({
        status: "renamed",
        path: paths[1],
        beforePath: paths[0],
        afterPath: paths[1],
        rawStatus,
      });
      continue;
    }

    if (rawStatus.startsWith("C")) {
      result.files.push({
        status: "unknown",
        path: paths[1],
        beforePath: paths[0],
        afterPath: paths[1],
        rawStatus,
      });
      continue;
    }

    result.files.push({
      status: mapStatus(rawStatus),
      path: paths[0],
      rawStatus,
    });
  }

  return result;
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
      ...(file.rawStatus.startsWith("C") && file.beforePath !== undefined
        ? { beforePath: file.beforePath }
        : {}),
      ...(file.rawStatus.startsWith("C") && file.afterPath !== undefined
        ? { afterPath: file.afterPath }
        : {}),
      hasBefore: false,
      hasAfter: false,
    };
  });
}
