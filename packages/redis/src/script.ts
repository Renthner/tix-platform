import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/** A Lua script executed via EVALSHA with transparent EVAL fallback (NOSCRIPT). */
export interface LuaScript {
  readonly name: string;
  readonly lua: string;
  readonly sha: string;
}

export function defineScript(name: string, lua: string): LuaScript {
  return { name, lua, sha: createHash('sha1').update(lua).digest('hex') };
}

export async function runScript<T = unknown>(
  client: Redis,
  script: LuaScript,
  keys: readonly string[],
  args: readonly (string | number)[],
): Promise<T> {
  try {
    return (await client.evalsha(script.sha, keys.length, ...keys, ...args)) as T;
  } catch (err) {
    if (err instanceof Error && err.message.includes('NOSCRIPT')) {
      return (await client.eval(script.lua, keys.length, ...keys, ...args)) as T;
    }
    throw err;
  }
}
