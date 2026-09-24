#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);

if (![base, head].every((sha) => /^[0-9a-f]{40}$/i.test(sha ?? ''))) {
  console.error('Usage: node scripts/check-commit-attribution.mjs <base-sha> <head-sha>');
  process.exit(2);
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

const forbidden = [
  [/^\s*Co-Authored-By:\s*(?:Claude\b|[^\n]*<(?:noreply|claude-code)@anthropic\.com>)/im, 'Claude co-author'],
  [/^\s*Claude-Session\s*:/im, 'Claude session trailer'],
  [/^\s*Generated with Claude\b/im, 'Claude generation footer'],
];

try {
  const commits = git('rev-list', '--reverse', `${base}..${head}`).trim().split('\n').filter(Boolean);
  const violations = [];

  for (const sha of commits) {
    const message = git('show', '-s', '--format=%B', sha);
    for (const [pattern, label] of forbidden) {
      if (pattern.test(message)) violations.push(`${sha.slice(0, 12)}: ${label}`);
    }
  }

  if (violations.length) {
    console.error('Automated Claude attribution found in new commits:\n' + violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Checked ${commits.length} commit(s): no automated Claude attribution.`);
  }
} catch (error) {
  console.error(`Could not check commit attribution: ${error.message}`);
  process.exitCode = 2;
}
