import { describe, expect, it } from 'vitest';
import { readSecretEnv, resolveSecretEnv } from '../src/server/secret-env';

const files: Record<string, string> = {
  '/run/a': 'from-file\n',
  '/run/empty': '  \n',
};
const read = (path: string): string => {
  const content = files[path];
  if (content === undefined) throw new Error('ENOENT');
  return content;
};

describe('readSecretEnv', () => {
  it('prefers the variable over the file', () => {
    expect(readSecretEnv('K', { K: 'direct', K_FILE: '/run/a' }, read)).toBe('direct');
  });
  it('reads and trims the file when the variable is unset or empty', () => {
    expect(readSecretEnv('K', { K_FILE: '/run/a' }, read)).toBe('from-file');
    expect(readSecretEnv('K', { K: '', K_FILE: '/run/a' }, read)).toBe('from-file');
  });
  it('returns undefined when neither is set', () => {
    expect(readSecretEnv('K', {}, read)).toBeUndefined();
    expect(readSecretEnv('K', { K_FILE: '' }, read)).toBeUndefined();
  });
  it('fails loudly on a missing or empty file', () => {
    expect(() => readSecretEnv('K', { K_FILE: '/run/none' }, read)).toThrow(/K_FILE: cannot read/);
    expect(() => readSecretEnv('K', { K_FILE: '/run/empty' }, read)).toThrow(/is empty/);
  });
});

describe('resolveSecretEnv', () => {
  it('fills resolved values into a copy and leaves other keys alone', () => {
    const source: Record<string, string> = { A_FILE: '/run/a', B: 'b', OTHER: 'x' };
    const out = resolveSecretEnv(['A', 'B', 'C'], source, read);
    expect(out).toMatchObject({ A: 'from-file', B: 'b', OTHER: 'x' });
    expect(out.C).toBeUndefined();
    expect(source).not.toHaveProperty('A');
  });
});
