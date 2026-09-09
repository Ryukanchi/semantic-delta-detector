import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadSemanticDeltaConfig } from "../src/config.js";

const repoRoot = process.cwd();
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxBinPath = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const prBeforePath = join(repoRoot, "examples", "pr-before.sql");
const prAfterPath = join(repoRoot, "examples", "pr-after.sql");

function withTempDir<T>(callback: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sdd-"));

  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("missing semantic-delta.yml does not enable CI gating", () => {
  withTempDir((dir) => {
    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
  });
});

test("semantic-delta.yml default before and after paths are loaded", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "fail_on: high",
        "default_before_path: ./examples/pr-before.sql",
        "default_after_path: './examples/pr-after.sql'",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = loadSemanticDeltaConfig(dir);

    assert.equal(config.failOn, "high");
    assert.equal(config.defaultBeforePath, "./examples/pr-before.sql");
    assert.equal(config.defaultAfterPath, "./examples/pr-after.sql");
  });
});

test("semantic-delta.yml include and ignore patterns are loaded", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "include:",
        "  - metrics/**",
        "  - 'models/**'",
        "ignore:",
        "  - docs/**",
        "  - README.md",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = loadSemanticDeltaConfig(dir);

    assert.deepEqual(config.include, ["metrics/**", "models/**"]);
    assert.deepEqual(config.ignore, ["docs/**", "README.md"]);
  });
});

test("semantic-delta.yml defaults missing include and ignore to empty arrays", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: high\n", "utf8");

    const config = loadSemanticDeltaConfig(dir);

    assert.equal(config.failOn, "high");
    assert.deepEqual(config.include, []);
    assert.deepEqual(config.ignore, []);
  });
});

test("semantic-delta.yml fail_on high enables CI gating", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: high\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /🔴 HIGH RISK/);
  });
});

test("semantic-delta.yml default paths are used when CLI paths are omitted", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "default_before_path: ./before.sql",
        "default_after_path: ./after.sql",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "before.sql"),
      "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
      "utf8",
    );
    writeFileSync(
      join(dir, "after.sql"),
      "SELECT COUNT(*) FROM events WHERE event = 'login'",
      "utf8",
    );

    const result = spawnSync(tsxBinPath, [cliPath, "--pr"], {
      cwd: dir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
    assert.match(result.stdout, /Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  });
});

test("CLI before and after paths override semantic-delta.yml defaults", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "default_before_path: ./before.sql",
        "default_after_path: ./after.sql",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "before.sql"),
      "SELECT COUNT(*) FROM users WHERE country = 'DE'",
      "utf8",
    );
    writeFileSync(
      join(dir, "after.sql"),
      "SELECT COUNT(*) FROM users WHERE country = 'DE'",
      "utf8",
    );

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
    assert.match(result.stdout, /Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  });
});

const explicitBeforeQuery = "SELECT COUNT(DISTINCT user_id) FROM events";
const explicitAfterQuery = "SELECT COUNT(*) FROM events";

function withInputPrecedenceFixture(callback: (dir: string) => void): void {
  withTempDir((dir) => {
    const files = {
      "default.sql": "SELECT COUNT(*) FROM configured_default",
      "before.sql": explicitBeforeQuery,
      "after.sql": explicitAfterQuery,
      "before.json": JSON.stringify({ query: explicitBeforeQuery, metric_name: "selected_before" }),
      "after.json": JSON.stringify({ query: explicitAfterQuery, metric_name: "selected_after" }),
      "invalid.json": JSON.stringify({ query: explicitBeforeQuery, metric_name: 123 }),
      "semantic-delta.yml": "fail_on: high\ndefault_before_path: ./default.sql\ndefault_after_path: ./default.sql\n",
    };

    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents, "utf8");
    }
    callback(dir);
  });
}

const directInputCases = [
  { name: "inline SQL", args: ["--query-a", explicitBeforeQuery, "--query-b", explicitAfterQuery] },
  { name: "SQL files", args: ["--file-a", "before.sql", "--file-b", "after.sql"] },
  { name: "JSON definitions", args: ["--json-a", "before.json", "--json-b", "after.json"] },
  { name: "mixed inputs", args: ["--file-a", "before.sql", "--query-b", explicitAfterQuery] },
];

for (const { name, args } of directInputCases) {
  test(`CLI ${name} override configured default input paths and retain config gating`, () => {
    withInputPrecedenceFixture((dir) => {
      const defaults = [
        "default_before_path: ./default.sql\ndefault_after_path: ./default.sql\n",
        "default_before_path: ./missing-before.sql\ndefault_after_path: ./missing-after.sql\n",
        "default_before_path: ./missing-before.sql\n",
      ];

      for (const paths of defaults) {
        writeFileSync(join(dir, "semantic-delta.yml"), `fail_on: high\n${paths}`, "utf8");
        const result = spawnSync(tsxBinPath, [cliPath, ...args, "--format", "json"], {
          cwd: dir,
          encoding: "utf8",
        });

        assert.equal(result.status, 1, `${paths}${result.stderr || result.stdout}`);
        assert.equal(result.stderr, "");
        const report = JSON.parse(result.stdout);
        assert.equal(report.risk_level, "high");
        assert.ok(report.detected_differences.some(
          (difference: { description: string }) =>
            difference.description.startsWith("Aggregation changed from COUNT(DISTINCT user_id) to COUNT(*)."),
        ));
        if (name === "JSON definitions") {
          assert.equal(report.metric_name_a, "selected_before");
          assert.equal(report.metric_name_b, "selected_after");
        }
      }
    });
  });
}

test("CLI incomplete direct inputs are not replaced by configured defaults", () => {
  withInputPrecedenceFixture((dir) => {
    for (const { args } of directInputCases.slice(0, 3)) {
      for (const incompleteArgs of [args.slice(0, 2), args.slice(2)]) {
        const result = spawnSync(tsxBinPath, [cliPath, ...incompleteArgs, "--format", "json"], {
          cwd: dir,
          encoding: "utf8",
        });

        assert.equal(result.status, 2, incompleteArgs.join(" "));
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Provide both inputs via --query-a\/--query-b/);
      }
    }
  });
});

test("CLI explicit input errors are not hidden by configured defaults", () => {
  withInputPrecedenceFixture((dir) => {
    const cases = [
      { args: ["--file-a", "missing.sql", "--file-b", "after.sql"], error: /Query A file does not exist: missing\.sql/ },
      { args: ["--json-a", "invalid.json", "--json-b", "after.json"], error: /field "metric_name" must be a string/ },
      { args: ["--query-a", "/* comment only */", "--query-b", explicitAfterQuery], error: /Query A SQL input must contain analyzable content/ },
    ];

    for (const { args, error } of cases) {
      const result = spawnSync(tsxBinPath, [cliPath, ...args, "--format", "json"], {
        cwd: dir,
        encoding: "utf8",
      });

      assert.equal(result.status, 2, args.join(" "));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, error);
    }
  });
});

test("CLI single before or after override retains the other configured path", () => {
  withInputPrecedenceFixture((dir) => {
    const cases = [
      { args: ["--before", "before.sql"], paths: "default_before_path: ./missing.sql\ndefault_after_path: ./after.sql\n" },
      { args: ["--after", "after.sql"], paths: "default_before_path: ./before.sql\ndefault_after_path: ./missing.sql\n" },
    ];

    for (const { args, paths } of cases) {
      writeFileSync(join(dir, "semantic-delta.yml"), `fail_on: high\n${paths}`, "utf8");
      const result = spawnSync(tsxBinPath, [cliPath, ...args, "--format", "json"], {
        cwd: dir,
        encoding: "utf8",
      });

      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(JSON.parse(result.stdout).risk_level, "high");
    }
  });
});

test("CLI --fail-on overrides semantic-delta.yml fail_on", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: high\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [
        cliPath,
        "--example",
        "same-de-users-formatting",
        "--pr",
        "--fail-on",
        "low",
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1);
  });
});

test("CLI --fail-on rejects critical threshold", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: high\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [
        cliPath,
        "--before",
        prBeforePath,
        "--after",
        prAfterPath,
        "--pr",
        "--fail-on",
        "critical",
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /Invalid --fail-on value "critical"\. Supported values: low, medium, high\./,
    );
  });
});

test("CLI example ignores semantic-delta.yml default paths", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "fail_on: high",
        "default_before_path: ./missing-before.sql",
        "default_after_path: ./missing-after.sql",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--example", "same-de-users-formatting", "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🟢 LOW RISK/);
    assert.match(result.stdout, /No meaningful semantic change detected\./);
  });
});

test("invalid semantic-delta.yml fail_on reports a clear error with exit code 2", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: urgent\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /Invalid semantic-delta\.yml fail_on value "urgent"\. Supported values: low, medium, high\./,
    );
  });
});

test("unknown semantic-delta.yml key fails with exit code 2 and helpful error", () => {
  const cases = ["failOn: high\n", "fail-on: high\n", "unexpected_key: true\n"];

  for (const content of cases) {
    withTempDir((dir) => {
      writeFileSync(join(dir, "semantic-delta.yml"), content, "utf8");

      const result = spawnSync(
        tsxBinPath,
        [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
        {
          cwd: dir,
          encoding: "utf8",
        },
      );

      assert.equal(result.status, 2);
      assert.match(
        result.stderr,
        /Unknown configuration key ".*" in semantic-delta\.yml\. Supported keys: fail_on, default_before_path, default_after_path, include, ignore\./,
      );
    });
  }
});
