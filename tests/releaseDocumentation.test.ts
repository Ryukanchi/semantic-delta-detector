import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");

test("README provides an installable v1 quick start", () => {
  assert.match(readme, /npm install semantic-delta-detector/);
  assert.match(readme, /package is ESM-only/);
  assert.match(
    readme,
    /npx semantic-delta-detector --example unique-login-users-vs-login-event-rows --pr/,
  );
});

test("README documents the synchronous and isolated PostgreSQL contracts", () => {
  assert.match(
    readme,
    /compareSqlQueriesIsolated[\s\S]*semantic-delta-detector\/postgresql/,
  );
  assert.match(readme, /timeoutMs:\s*2_000/);
  assert.match(readme, /synchronous[\s\S]*calling thread/i);
  assert.match(readme, /isolated[\s\S]*Worker/i);
});

test("README separates semantic risk from analysis confidence", () => {
  assert.match(readme, /## Risk vs confidence/);
  assert.match(readme, /Risk and confidence are independent/i);
  assert.match(readme, /not a SQL validator, equivalence prover/i);
});
