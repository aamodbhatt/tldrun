#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE_DAYS = 21;
const DOCS = [
  'README.md',
  'STATUS.md',
  'IMPLEMENTATIONS.md',
  'SECURITY.md',
  'TODO.md',
  'ROADMAP.md',
  'DOCS_OPERATIONS.md',
];

const DATE_RE = /Last updated:\s*(\d{4}-\d{2}-\d{2})/i;
const now = new Date();
let hasError = false;

const diffDays = (a, b) => {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / oneDay));
};

for (const doc of DOCS) {
  const abs = path.resolve(process.cwd(), doc);
  if (!fs.existsSync(abs)) {
    console.error(`[docs-check] Missing required doc: ${doc}`);
    hasError = true;
    continue;
  }

  const content = fs.readFileSync(abs, 'utf8');
  const match = content.match(DATE_RE);
  if (!match) {
    console.error(`[docs-check] Missing \"Last updated: YYYY-MM-DD\" in ${doc}`);
    hasError = true;
    continue;
  }

  const updatedAt = new Date(`${match[1]}T00:00:00Z`);
  if (Number.isNaN(updatedAt.getTime())) {
    console.error(`[docs-check] Invalid date format in ${doc}: ${match[1]}`);
    hasError = true;
    continue;
  }

  const age = diffDays(now, updatedAt);
  if (age > MAX_AGE_DAYS) {
    console.error(`[docs-check] Stale doc (${age} days): ${doc}`);
    hasError = true;
    continue;
  }

  console.log(`[docs-check] OK (${age}d): ${doc}`);
}

if (hasError) {
  process.exit(1);
}

console.log('[docs-check] All canonical docs are fresh.');
