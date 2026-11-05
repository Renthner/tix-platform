// Verifies that every locale has exactly the same message keys and ICU placeholders as the
// default locale (English). Run via `pnpm --filter @tix/web test`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'messages');
const reference = 'en';
const locales = readdirSync(root).filter((l) => l !== reference);

function flatten(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, out);
    else out.set(path, String(value));
  }
  return out;
}

/** Top-level ICU argument names, e.g. "{count, plural, …}" → count, "{price}" → price. */
function placeholders(message) {
  const names = new Set();
  let depth = 0;
  for (let i = 0; i < message.length; i += 1) {
    const ch = message[i];
    if (ch === '{') {
      if (depth === 0) {
        const match = /^\{\s*([A-Za-z0-9_]+)/.exec(message.slice(i));
        if (match) names.add(match[1]);
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
  }
  return [...names].sort().join(',');
}

let errors = 0;
for (const file of readdirSync(join(root, reference))) {
  const base = flatten(JSON.parse(readFileSync(join(root, reference, file), 'utf8')));
  for (const locale of locales) {
    const other = flatten(JSON.parse(readFileSync(join(root, locale, file), 'utf8')));
    for (const [key, message] of base) {
      if (!other.has(key)) {
        console.error(`✗ ${locale}/${file}: missing "${key}"`);
        errors += 1;
      } else if (placeholders(message) !== placeholders(other.get(key))) {
        console.error(`✗ ${locale}/${file}: placeholders differ for "${key}"`);
        errors += 1;
      }
    }
    for (const key of other.keys()) {
      if (!base.has(key)) {
        console.error(`✗ ${locale}/${file}: unknown key "${key}"`);
        errors += 1;
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n${errors} translation problem(s) found.`);
  process.exit(1);
}
console.log(`✓ translations consistent (${[reference, ...locales].join(', ')})`);
