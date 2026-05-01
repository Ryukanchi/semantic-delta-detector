export interface PathFilterDecision {
  included: boolean;
  reason: string;
}

interface PathFilterOptions {
  include?: string[];
  ignore?: string[];
}

export interface FilteredPath {
  path: string;
  reason: string;
}

export interface CandidatePathFilterResult {
  included: FilteredPath[];
  skipped: FilteredPath[];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern === normalizedPath) {
    return true;
  }

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.startsWith("**/*.")) {
    const extension = normalizedPattern.slice("**/*".length);
    return normalizedPath.endsWith(extension);
  }

  return false;
}

export function shouldIncludePath(
  filePath: string,
  options: PathFilterOptions,
): PathFilterDecision {
  const include = options.include ?? [];
  const ignore = options.ignore ?? [];

  const matchingIgnore = ignore.find((pattern) => matchesPattern(filePath, pattern));
  if (matchingIgnore) {
    return {
      included: false,
      reason: `excluded by ignore pattern: ${matchingIgnore}`,
    };
  }

  if (include.length === 0) {
    return {
      included: true,
      reason: "included by default",
    };
  }

  const matchingInclude = include.find((pattern) => matchesPattern(filePath, pattern));
  if (matchingInclude) {
    return {
      included: true,
      reason: `included by include pattern: ${matchingInclude}`,
    };
  }

  return {
    included: false,
    reason: "excluded because no include pattern matched",
  };
}

export function filterCandidatePaths(
  paths: string[],
  options: PathFilterOptions,
): CandidatePathFilterResult {
  const result: CandidatePathFilterResult = {
    included: [],
    skipped: [],
  };

  for (const path of paths) {
    const decision = shouldIncludePath(path, options);
    const filteredPath = {
      path,
      reason: decision.reason,
    };

    if (decision.included) {
      result.included.push(filteredPath);
    } else {
      result.skipped.push(filteredPath);
    }
  }

  return result;
}
