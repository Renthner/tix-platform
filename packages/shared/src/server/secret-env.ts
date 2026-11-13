import { readFileSync } from 'node:fs';

type EnvSource = Record<string, string | undefined>;
type FileReader = (path: string) => string;

/**
 * Reads a secret from the environment with Docker-secrets style fallback: `NAME` wins when it is
 * set and not empty, otherwise `NAME_FILE` names a file whose trimmed content is the value.
 * Returns undefined when neither is set; throws a readable error when the file is unreadable or
 * empty (a configured but broken secret must fail loudly, not fall back to nothing).
 */
export function readSecretEnv(
  name: string,
  source: EnvSource = process.env,
  readFile: FileReader = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  const direct = source[name];
  if (direct !== undefined && direct !== '') return direct;
  const path = source[`${name}_FILE`];
  if (path === undefined || path === '') return undefined;
  let content: string;
  try {
    content = readFile(path).trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}_FILE: cannot read ${path} (${reason})`);
  }
  if (content === '') throw new Error(`${name}_FILE: ${path} is empty`);
  return content;
}

/** Copy of `source` in which every listed name is resolved with {@link readSecretEnv}. */
export function resolveSecretEnv<T extends EnvSource>(
  names: readonly string[],
  source: T,
  readFile?: FileReader,
): T {
  const out: EnvSource = { ...source };
  for (const name of names) {
    const value = readSecretEnv(name, source, readFile);
    if (value !== undefined) out[name] = value;
  }
  return out as T;
}
