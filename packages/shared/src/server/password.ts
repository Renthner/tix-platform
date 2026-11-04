import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with Argon2id (Node.js built-in `crypto.argon2`, no native addon).
 * Parameters follow the OWASP Password Storage Cheat Sheet baseline
 * (m = 19 MiB, t = 2, p = 1). Hashes are encoded in PHC string format so parameters can
 * be raised later; `needsRehash` tells the login flow to upgrade stored hashes.
 */

export interface Argon2Params {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

export const DEFAULT_ARGON2_PARAMS: Readonly<Argon2Params> = Object.freeze({
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
});

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(
  password: string,
  salt: Buffer,
  params: Argon2Params,
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password.normalize('NFKC'), 'utf8'),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength,
        memory: params.memoryKiB,
        passes: params.passes,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  if (password.length === 0) throw new Error('Password must not be empty');
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, params, TAG_BYTES);
  return `$argon2id$v=19$m=${params.memoryKiB},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

function parse(phc: string) {
  const m = PHC_PATTERN.exec(phc);
  if (!m) return null;
  const [, mem, t, p, salt, hash] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    params: { memoryKiB: Number(mem), passes: Number(t), parallelism: Number(p) },
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64'),
  };
}

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  const parsed = parse(phc);
  if (!parsed || parsed.hash.length === 0) return false;
  const candidate = await derive(password, parsed.salt, parsed.params, parsed.hash.length);
  return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
}

export function needsRehash(phc: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): boolean {
  const parsed = parse(phc);
  if (!parsed) return true;
  return (
    parsed.params.memoryKiB < params.memoryKiB ||
    parsed.params.passes < params.passes ||
    parsed.params.parallelism !== params.parallelism
  );
}
