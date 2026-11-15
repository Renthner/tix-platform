/**
 * Guards for the secret registry (`src/secrets/registry.ts`): a new encrypted column or a new
 * `encrypt(` call site must be registered, otherwise a restore of a backup of another system could
 * leave it dependent on the foreign key for ever. See the registry for how to add an entry.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import * as schema from '@tix/db';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ENCRYPT_CALL_SITES, SECRET_COLUMNS, TRANSIENT_ENCRYPT_CALL_SITES } from '../src';

/** Some exports are null-prototype objects (value lists): `is()` cannot inspect those. */
const isTable = (value: unknown): value is PgTable =>
  typeof value === 'object' &&
  value !== null &&
  Object.getPrototypeOf(value) !== null &&
  is(value, PgTable);

const root = resolve(import.meta.dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', 'dist', 'test', 'build'].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('secret registry', () => {
  it('has unique ids and every id is claimed by a call site', () => {
    const ids = SECRET_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const claimed = new Set(Object.values(ENCRYPT_CALL_SITES).flat());
    for (const id of ids) expect(claimed, `${id} has no entry in ENCRYPT_CALL_SITES`).toContain(id);
    for (const id of claimed) expect(ids, `unknown registry id ${id}`).toContain(id);
  });

  it('lists every *_encrypted / *_ciphertext column of the Drizzle schema', () => {
    const registered = new Set(SECRET_COLUMNS.map((c) => `${c.table}.${c.column}`));
    const found: string[] = [];
    for (const value of Object.values(schema)) {
      if (!isTable(value)) continue;
      const { name, columns } = getTableConfig(value);
      for (const column of columns) {
        if (/encrypted|ciphertext|sealed/i.test(column.name)) found.push(`${name}.${column.name}`);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) {
      expect(
        registered,
        `${entry} looks like an encrypted column but is not in SECRET_COLUMNS (packages/core/src/secrets/registry.ts)`,
      ).toContain(entry);
    }
    // And the other way round: a registered column must exist.
    const existing = new Set<string>();
    for (const value of Object.values(schema)) {
      if (!isTable(value)) continue;
      const { name, columns } = getTableConfig(value);
      for (const column of columns) existing.add(`${name}.${column.name}`);
    }
    for (const entry of registered) expect(existing, `${entry} does not exist`).toContain(entry);
  });

  it('knows every source file that encrypts a value with a secret box', () => {
    const known = new Set([
      ...Object.keys(ENCRYPT_CALL_SITES),
      ...Object.keys(TRANSIENT_ENCRYPT_CALL_SITES),
    ]);
    const implementation = new Set([
      'packages/shared/src/server/secret-box.ts',
      'packages/shared/src/server/key-ring.ts',
      // The re-encryption itself (writes what the registry describes).
      'packages/core/src/secrets/reencrypt.ts',
    ]);
    const used = new Set<string>();
    for (const base of ['packages', 'apps']) {
      for (const pkg of readdirSync(join(root, base))) {
        const src = join(root, base, pkg, 'src');
        try {
          statSync(src);
        } catch {
          continue;
        }
        for (const file of walk(src)) {
          const rel = relative(root, file).split(sep).join('/');
          if (implementation.has(rel)) continue;
          if (/\.(encrypt|encryptJson)\(/.test(readFileSync(file, 'utf8'))) used.add(rel);
        }
      }
    }
    for (const file of used) {
      expect(
        known,
        `${file} calls encrypt(...): register what it stores in packages/core/src/secrets/registry.ts (or list it as transient)`,
      ).toContain(file);
    }
    for (const file of known) {
      expect(
        used,
        `${file} no longer calls encrypt(...): remove it from the registry lists`,
      ).toContain(file);
    }
  });
});
