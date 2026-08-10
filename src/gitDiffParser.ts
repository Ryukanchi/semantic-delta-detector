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

interface NulStatusDescriptor {
  rawStatus: string;
  status: GitDiffFileStatus;
  pathFieldCount: 1 | 2;
  isCopy: boolean;
}

interface NulPlanStep {
  statusIndex: number;
  descriptor: NulStatusDescriptor;
  consumedPathCount: number;
  nextIndex: number;
}

interface NulPlanState {
  count: 0 | 1 | 2;
  choice?: NulPlanStep;
}

export class GitDiffNulParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiffNulParseError";
  }
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

function describeNulStatus(field: Buffer): NulStatusDescriptor | undefined {
  const rawStatus = decodeNulField(field);
  if (rawStatus === undefined) {
    return undefined;
  }

  if (/^R(?:[0-9]{1,3})?$/.test(rawStatus)) {
    return {
      rawStatus,
      status: "renamed",
      pathFieldCount: 2,
      isCopy: false,
    };
  }

  if (/^C(?:[0-9]{1,3})?$/.test(rawStatus)) {
    return {
      rawStatus,
      status: "unknown",
      pathFieldCount: 2,
      isCopy: true,
    };
  }

  if (/^[A-Z]$/.test(rawStatus)) {
    return {
      rawStatus,
      status: mapStatus(rawStatus),
      pathFieldCount: 1,
      isCopy: false,
    };
  }

  return undefined;
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

function formatNulStreamPreview(fields: Buffer[]): string {
  const previewFields = fields.slice(0, 8);
  const suffix = fields.length > previewFields.length
    ? ` NUL … (${fields.length - previewFields.length} more fields)`
    : "";
  return `${formatNulFields(previewFields)}${suffix}`;
}

function tokenizeNulOutput(output: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let offset = 0;

  while (offset < output.length) {
    const field = readNulField(output, offset);
    if (!field) {
      break;
    }

    fields.push(field.bytes);
    if (!field.terminated) {
      throw new GitDiffNulParseError(
        `NUL-delimited Git diff output ended without a terminal NUL; no records were accepted. Fields: ${formatNulStreamPreview(fields)}`,
      );
    }
    offset = field.nextOffset;
  }

  return fields;
}

function buildNulPlan(fields: Buffer[]): NulPlanStep[] {
  const descriptors = fields.map((field) => describeNulStatus(field));
  const states: NulPlanState[] = Array.from(
    { length: fields.length + 1 },
    (): NulPlanState => ({ count: 0 }),
  );
  states[fields.length] = { count: 1 };

  for (let statusIndex = fields.length - 1; statusIndex >= 0; statusIndex -= 1) {
    const descriptor = descriptors[statusIndex];
    if (!descriptor) {
      continue;
    }

    const options: Array<{ step: NulPlanStep; childCount: 1 | 2 }> = [];
    const addOption = (consumedPathCount: number): void => {
      const nextIndex = statusIndex + 1 + consumedPathCount;
      const childState = states[nextIndex];
      if (!childState || childState.count === 0) {
        return;
      }

      options.push({
        step: {
          statusIndex,
          descriptor,
          consumedPathCount,
          nextIndex,
        },
        childCount: childState.count,
      });
    };

    if (statusIndex + 1 + descriptor.pathFieldCount <= fields.length) {
      addOption(descriptor.pathFieldCount);
    }

    for (
      let consumedPathCount = 0;
      consumedPathCount < descriptor.pathFieldCount;
      consumedPathCount += 1
    ) {
      const recoveryIndex = statusIndex + 1 + consumedPathCount;
      if (recoveryIndex < fields.length && descriptors[recoveryIndex]) {
        addOption(consumedPathCount);
      }
    }

    let planCount: 0 | 1 | 2 = 0;
    for (const option of options) {
      planCount = Math.min(2, planCount + option.childCount) as 0 | 1 | 2;
    }
    states[statusIndex] =
      planCount === 1 && options.length === 1 && options[0].childCount === 1
        ? { count: 1, choice: options[0].step }
        : { count: planCount };
  }

  const rootState = states[0];
  if (!rootState || rootState.count === 0) {
    throw new GitDiffNulParseError(
      `NUL-delimited Git diff output has no safe complete record framing; no records were accepted. Fields: ${formatNulStreamPreview(fields)}`,
    );
  }
  if (rootState.count > 1) {
    throw new GitDiffNulParseError(
      `NUL-delimited Git diff output has ambiguous record boundaries; no records were accepted. Fields: ${formatNulStreamPreview(fields)}`,
    );
  }

  const plan: NulPlanStep[] = [];
  let index = 0;
  while (index < fields.length) {
    const choice = states[index]?.choice;
    if (!choice) {
      throw new GitDiffNulParseError(
        "NUL-delimited Git diff output could not be reconstructed safely; no records were accepted.",
      );
    }
    plan.push(choice);
    index = choice.nextIndex;
  }

  return plan;
}

/**
 * Parses `git diff --name-status -z` output without first converting the full
 * byte stream to text. This is intentionally not re-exported from the package
 * entry point; Git discovery owns the byte-oriented subprocess boundary.
 */
export function parseGitDiffNameStatusZ(
  output: Buffer,
): GitDiffNameStatusParseResult {
  const fields = tokenizeNulOutput(output);
  const plan = buildNulPlan(fields);
  const result: GitDiffNameStatusParseResult = {
    files: [],
    skipped: [],
  };

  for (const step of plan) {
    const { descriptor, statusIndex, consumedPathCount } = step;
    const recordFields = fields.slice(statusIndex, step.nextIndex);
    if (consumedPathCount < descriptor.pathFieldCount) {
      skipNulRecord(
        result,
        recordFields,
        `${descriptor.rawStatus} entry is truncated; expected ${descriptor.pathFieldCount} path field${descriptor.pathFieldCount === 1 ? "" : "s"} but only ${consumedPathCount} could be assigned without consuming a later record`,
      );
      continue;
    }

    const pathFields = fields.slice(
      statusIndex + 1,
      statusIndex + 1 + descriptor.pathFieldCount,
    );
    const decodedPaths = pathFields.map((field) => decodeNulField(field));
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

    if (descriptor.status === "renamed") {
      result.files.push({
        status: "renamed",
        path: paths[1],
        beforePath: paths[0],
        afterPath: paths[1],
        rawStatus: descriptor.rawStatus,
      });
      continue;
    }

    if (descriptor.isCopy) {
      result.files.push({
        status: "unknown",
        path: paths[1],
        beforePath: paths[0],
        afterPath: paths[1],
        rawStatus: descriptor.rawStatus,
      });
      continue;
    }

    result.files.push({
      status: descriptor.status,
      path: paths[0],
      rawStatus: descriptor.rawStatus,
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
