import test from "node:test";
import assert from "node:assert/strict";
import { filterCandidatePaths, shouldIncludePath } from "../src/pathFilter.js";

test("path filter includes by default when include and ignore are empty", () => {
  assert.deepEqual(shouldIncludePath("metrics/revenue.sql", {}), {
    included: true,
    reason: "included by default",
  });
});

test("path filter excludes exact ignore matches", () => {
  assert.deepEqual(shouldIncludePath("README.md", { ignore: ["README.md"] }), {
    included: false,
    reason: "excluded by ignore pattern: README.md",
  });
});

test("path filter excludes prefix ignore matches", () => {
  assert.deepEqual(shouldIncludePath("docs/readme.md", { ignore: ["docs/**"] }), {
    included: false,
    reason: "excluded by ignore pattern: docs/**",
  });
});

test("path filter includes matching include prefixes", () => {
  assert.deepEqual(shouldIncludePath("metrics/revenue.sql", { include: ["metrics/**"] }), {
    included: true,
    reason: "included by include pattern: metrics/**",
  });
});

test("path filter excludes when no include pattern matches", () => {
  assert.deepEqual(shouldIncludePath("docs/revenue.sql", { include: ["metrics/**"] }), {
    included: false,
    reason: "excluded because no include pattern matched",
  });
});

test("path filter lets ignore win over include", () => {
  assert.deepEqual(
    shouldIncludePath("metrics/archive/revenue.sql", {
      include: ["metrics/**"],
      ignore: ["metrics/archive/**"],
    }),
    {
      included: false,
      reason: "excluded by ignore pattern: metrics/archive/**",
    },
  );
});

test("path filter supports nested SQL extension globs", () => {
  assert.deepEqual(shouldIncludePath("models/marts/revenue.sql", { include: ["**/*.sql"] }), {
    included: true,
    reason: "included by include pattern: **/*.sql",
  });
});

test("path filter normalizes Windows-style backslashes", () => {
  assert.deepEqual(shouldIncludePath("metrics\\revenue.sql", { include: ["metrics/**"] }), {
    included: true,
    reason: "included by include pattern: metrics/**",
  });
});

test("candidate path filter splits mixed paths into included and skipped", () => {
  assert.deepEqual(
    filterCandidatePaths(["metrics/revenue.sql", "docs/revenue.sql", "metrics/archive/old.sql"], {
      include: ["metrics/**"],
      ignore: ["metrics/archive/**"],
    }),
    {
      included: [
        {
          path: "metrics/revenue.sql",
          reason: "included by include pattern: metrics/**",
        },
      ],
      skipped: [
        {
          path: "docs/revenue.sql",
          reason: "excluded because no include pattern matched",
        },
        {
          path: "metrics/archive/old.sql",
          reason: "excluded by ignore pattern: metrics/archive/**",
        },
      ],
    },
  );
});

test("candidate path filter preserves input order within included and skipped groups", () => {
  const result = filterCandidatePaths(
    ["models/a.sql", "docs/a.sql", "metrics/b.sql", "README.md", "models/c.sql"],
    {
      include: ["models/**", "metrics/**"],
      ignore: ["README.md"],
    },
  );

  assert.deepEqual(
    result.included.map((item) => item.path),
    ["models/a.sql", "metrics/b.sql", "models/c.sql"],
  );
  assert.deepEqual(
    result.skipped.map((item) => item.path),
    ["docs/a.sql", "README.md"],
  );
});

test("candidate path filter reports skip reasons from ignore patterns", () => {
  const result = filterCandidatePaths(["docs/readme.md"], { ignore: ["docs/**"] });

  assert.deepEqual(result.skipped, [
    {
      path: "docs/readme.md",
      reason: "excluded by ignore pattern: docs/**",
    },
  ]);
});

test("candidate path filter reports skip reasons when no include pattern matches", () => {
  const result = filterCandidatePaths(["docs/revenue.sql"], { include: ["metrics/**"] });

  assert.deepEqual(result.skipped, [
    {
      path: "docs/revenue.sql",
      reason: "excluded because no include pattern matched",
    },
  ]);
});

test("candidate path filter handles empty path lists", () => {
  assert.deepEqual(filterCandidatePaths([], { include: ["metrics/**"], ignore: ["docs/**"] }), {
    included: [],
    skipped: [],
  });
});

test("candidate path filter works with include missing and ignore present", () => {
  assert.deepEqual(filterCandidatePaths(["metrics/revenue.sql", "docs/readme.md"], { ignore: ["docs/**"] }), {
    included: [
      {
        path: "metrics/revenue.sql",
        reason: "included by default",
      },
    ],
    skipped: [
      {
        path: "docs/readme.md",
        reason: "excluded by ignore pattern: docs/**",
      },
    ],
  });
});
