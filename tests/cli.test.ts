import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    },
  );
}

test("CLI help uses the installed command and a real bundled example", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /semantic-delta-detector --query-a "SELECT \.\.\." --query-b "SELECT \.\.\."/,
  );
  assert.match(
    result.stdout,
    /semantic-delta-detector --example unique-login-users-vs-login-event-rows/,
  );
  assert.doesNotMatch(result.stdout, /pnpm compare/);
  assert.doesNotMatch(result.stdout, /--example login-vs-paid/);
});

test("CLI PR examples include validated semantic cases", () => {
  const output = execFileSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--example",
      "unique-login-users-vs-login-event-rows",
      "--pr",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.match(output, /🔴 HIGH RISK/);
  assert.match(output, /Impact: aggregation changes may change what is counted\./);
  assert.match(output, /Evidence:\n- Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  assert.match(output, /Recommendation: Do not compare unique-user login counts/i);
});

test("CLI PR examples include a calm formatting-only low-risk case", () => {
  const output = execFileSync(
    "npm",
    ["run", "compare", "--", "--example", "same-de-users-formatting", "--pr"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.match(output, /🟢 LOW RISK/);
  assert.match(output, /No meaningful semantic change detected\./);
  assert.match(output, /Impact: No significant business impact detected\./);
  assert.match(output, /Recommendation: No action required beyond normal review\./);
});

test("unknown CLI example lists newly added examples", () => {
  assert.throws(
    () =>
      execFileSync("npm", ["run", "compare", "--", "--example", "missing-example"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      }),
    /Available examples: .*same-de-users-formatting.*unique-login-users-vs-login-event-rows.*paid-users-vs-all-users.*daily-login-counts-vs-monthly-login-counts.*left-join-vs-inner-join/,
  );
});

test("CLI PR simulation reads before and after SQL files", () => {
  const output = execFileSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--before",
      "./examples/pr-before.sql",
      "--after",
      "./examples/pr-after.sql",
      "--pr",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.match(output, /🔴 HIGH RISK/);
  assert.match(output, /Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  assert.match(output, /Confirm whether the metric is intended to count users or events\./);
});

test("CLI PR simulation requires both before and after files", () => {
  assert.throws(
    () =>
      execFileSync(
        "npm",
        ["run", "compare", "--", "--before", "./examples/pr-before.sql", "--pr"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /Provide both --before and --after for PR simulation/,
  );
});

test("CLI PR simulation reports missing before and after files clearly", () => {
  assert.throws(
    () =>
      execFileSync(
        "npm",
        [
          "run",
          "compare",
          "--",
          "--before",
          "./examples/missing-before.sql",
          "--after",
          "./examples/pr-after.sql",
          "--pr",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /Before file does not exist: \.\/examples\/missing-before\.sql/,
  );

  assert.throws(
    () =>
      execFileSync(
        "npm",
        [
          "run",
          "compare",
          "--",
          "--before",
          "./examples/pr-before.sql",
          "--after",
          "./examples/missing-after.sql",
          "--pr",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /After file does not exist: \.\/examples\/missing-after\.sql/,
  );
});

test("cli reports friendly validation errors for malformed json metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdd-"));
  const badAPath = join(dir, "bad-a.json");
  const badBPath = join(dir, "bad-b.json");

  writeFileSync(
    badAPath,
    JSON.stringify({ metric_name: 123, query: "SELECT COUNT(*) FROM users" }),
    "utf8",
  );
  writeFileSync(
    badBPath,
    JSON.stringify({ query: "SELECT COUNT(*) FROM users" }),
    "utf8",
  );

  assert.throws(
    () =>
      execFileSync(
        "corepack",
        [
          "pnpm",
          "compare",
          "--json-a",
          badAPath,
          "--json-b",
          badBPath,
          "--format",
          "json",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /field "metric_name" must be a string if provided/,
  );
});

test("CLI rejects unknown options with exit code 1", () => {
  const cases = [
    ["--wat"],
    ["--formt", "json"],
    ["--changed-froom", "HEAD"],
    ["--fail-onn", "medium"],
  ];

  for (const args of cases) {
    const result = runCli(args);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`Error: Unknown option: ${args[0]}`));
  }
});

test("CLI rejects unexpected positional arguments", () => {
  const result = runCli(["surprise"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Error: Unexpected positional argument: surprise/);
});

test("CLI continues to consume values for valid nearby options", () => {
  const formatResult = runCli([
    "--example",
    "same-de-users-formatting",
    "--format",
    "json",
  ]);
  assert.equal(formatResult.status, 0, formatResult.stderr);
  assert.equal(JSON.parse(formatResult.stdout).risk_level, "low");

  const gateResult = runCli([
    "--example",
    "same-de-users-formatting",
    "--fail-on",
    "medium",
    "--pr",
  ]);
  assert.equal(gateResult.status, 0, gateResult.stderr);
  assert.match(gateResult.stdout, /LOW RISK/);

  const gitResult = runCli([
    "--changed-from",
    "HEAD",
    "--changed-to",
    "HEAD",
    "--repo",
    process.cwd(),
    "--format",
    "json",
  ]);
  assert.equal(gitResult.status, 0, gitResult.stderr);
  assert.equal(JSON.parse(gitResult.stdout).summary.discoveredCount, 0);
});
