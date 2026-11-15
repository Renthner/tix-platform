import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Software WebAuthn authenticator for tests: ES256 key pair, `none` attestation, assertions over
 * the real wire format, so the real @simplewebauthn/server verification runs end to end.
 */

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const b64url = (data: Buffer) => data.toString('base64url');

// Minimal CBOR encoder (ints, byte strings, text strings, maps).
function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(value, 1);
  return b;
}
type Cbor = number | Buffer | string | Map<Cbor, Cbor>;
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  const parts: Buffer[] = [cborHead(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface AuthenticatorOptions {
  rpID: string;
  origin: string;
}

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  counter = 0;
  /** Set to false to simulate an authenticator that does not verify the user. */
  userVerified = true;
  /** Synced passkeys: backup eligible + backed up, counter stays 0. */
  synced = false;

  constructor(readonly rp: AuthenticatorOptions) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private flags(extra = 0): number {
    return (
      FLAG_UP | (this.userVerified ? FLAG_UV : 0) | (this.synced ? FLAG_BE | FLAG_BS : 0) | extra
    );
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin?: string) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: origin ?? this.rp.origin, crossOrigin: false }),
    );
  }

  /** Attestation (registration) response for the challenge of the creation options. */
  register(challenge: string, opts: { origin?: string } = {}) {
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(this.rp.rpID),
      Buffer.from([this.flags(FLAG_AT)]),
      counter,
      Buffer.alloc(16),
      idLength,
      this.credentialId,
      cbor(coseKey),
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', challenge, opts.origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** Assertion (sign-in) response; increments the counter unless synced. */
  assert(challenge: string, opts: { origin?: string; userHandle?: string; counter?: number } = {}) {
    if (!this.synced) this.counter = opts.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rp.rpID), Buffer.from([this.flags()]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', challenge, opts.origin);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(opts.userHandle === undefined
          ? {}
          : { userHandle: b64url(Buffer.from(opts.userHandle)) }),
      },
    };
  }
}
