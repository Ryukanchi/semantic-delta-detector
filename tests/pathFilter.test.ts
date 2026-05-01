import test from "node:test";
import assert from "node:assert/strict";
import { shouldIncludePath } from "../src/pathFilter.js";

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
