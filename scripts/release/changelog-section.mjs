#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version (without its heading).
//   node scripts/release/changelog-section.mjs <version> [CHANGELOG.md]
import { readFileSync } from 'node:fs';

const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
if (!version) {
  console.error('usage: changelog-section.mjs <version> [file]');
  process.exit(2);
}
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const heading = new RegExp(`^## \\[${version.replace(/[.+-]/g, '\\$&')}\\]`);
const start = lines.findIndex((l) => heading.test(l));
if (start < 0) {
  console.error(`No "## [${version}]" section in ${file}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^(## |\[[^\]]+\]: )/.test(l));
if (end < 0) end = lines.length;
const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();
if (!body) {
  console.error(`Section [${version}] is empty`);
  process.exit(1);
}
console.log(body);
