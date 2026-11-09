import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { base64urlEncode, type TicketSigner } from '../tickets/qr';

/** PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export interface Ed25519KeyMaterial {
  /** 32-byte seed (the private key), base64url. */
  seed: string;
  /** Raw 32-byte public key, base64url. */
  publicKey: string;
}

/** Raw 32-byte public key (base64url) belonging to a 32-byte seed. */
export function publicKeyFromSeed(seed: Uint8Array): string {
  return createPublicKey(privateKeyFromSeed(seed)).export({ format: 'jwk' }).x!;
}

export function generateEd25519KeyMaterial(): Ed25519KeyMaterial {
  const seed = randomBytes(32);
  return { seed: base64urlEncode(seed), publicKey: publicKeyFromSeed(seed) };
}

/** Signer for `buildTicketPayload` from a 32-byte seed. */
export function ed25519Signer(seed: Uint8Array): TicketSigner {
  const key = privateKeyFromSeed(seed);
  return (data) => new Uint8Array(sign(null, data, key));
}
