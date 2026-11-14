import { randomBytes, randomUUID } from 'node:crypto';
import { eventSigningKeys, events, tickets, withTransaction, type Transaction } from '@tix/db';
import { base64urlEncode } from '@tix/shared';
import {
  ed25519Signer,
  generateEd25519KeyMaterial,
  publicKeyFromSeed,
  type Ed25519KeyMaterial,
} from '@tix/shared/server';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';

/**
 * Per-event Ed25519 signing keys for ticket QR codes. The private key (32-byte seed) is
 * secret-box encrypted with AAD `signing-key:<event_signing_keys.id>`, so a ciphertext cannot
 * be moved to another key row or event. The public part is distributed to scanners.
 *
 * Exactly one ACTIVE key per event (partial unique index); creation / rotation are
 * serialised with a transaction-scoped advisory lock per event. RETIRED keys keep verifying
 * existing tickets; REVOKED keys do not (tickets signed with them must be re-issued).
 */

export type SigningKeyRow = typeof eventSigningKeys.$inferSelect;

export interface TicketSigningKey {
  /** Row id (UUID) – stored on tickets. */
  id: string;
  /** Short id embedded in QR payloads. */
  keyId: string;
  publicKey: string;
  signer: ReturnType<typeof ed25519Signer>;
}

export interface EventPublicKey {
  keyId: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
  status: SigningKeyRow['status'];
}

const MAX_KEY_ID_ATTEMPTS = 5;
const aad = (rowId: string) => `signing-key:${rowId}`;
const lockSql = (eventId: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtext(${`signing-key:${eventId}`}))`;

function newKeyId(): string {
  return base64urlEncode(randomBytes(6)); // 8 chars, matches TICKET_KEY_ID_PATTERN
}

function toSigningKey(ctx: CoreContext, row: SigningKeyRow): TicketSigningKey {
  const secrets = requireCapability(ctx, 'secrets');
  const material = secrets.decryptJson<{ seed: string }>(row.privateKeyEncrypted, aad(row.id));
  const seed = Buffer.from(material.seed, 'base64url');
  if (publicKeyFromSeed(seed) !== row.publicKey) {
    throw new Error(`Signing key ${row.id} is corrupt: stored public key does not match the seed`);
  }
  return { id: row.id, keyId: row.keyId, publicKey: row.publicKey, signer: ed25519Signer(seed) };
}

async function insertActiveKey(
  ctx: CoreContext,
  tx: Transaction,
  eventId: string,
): Promise<SigningKeyRow> {
  const secrets = requireCapability(ctx, 'secrets');
  const material: Ed25519KeyMaterial = generateEd25519KeyMaterial();
  const id = randomUUID();
  // A random 48-bit key id can (very rarely) collide within the event; retry with a new one.
  for (let attempt = 0; attempt < MAX_KEY_ID_ATTEMPTS; attempt += 1) {
    const [row] = await tx
      .insert(eventSigningKeys)
      .values({
        id,
        eventId,
        keyId: newKeyId(),
        algorithm: 'Ed25519',
        publicKey: material.publicKey,
        privateKeyEncrypted: secrets.encryptJson({ seed: material.seed }, aad(id)),
        status: 'ACTIVE',
      })
      .onConflictDoNothing({ target: [eventSigningKeys.eventId, eventSigningKeys.keyId] })
      .returning();
    if (row) return row;
  }
  throw new Error('Could not allocate a unique signing key id');
}

/**
 * The ACTIVE key, read with `FOR SHARE`: revoke (FOR UPDATE) and rotate (UPDATE) wait for
 * in-flight issuance, and issuance that arrives while they run waits for them. In READ COMMITTED
 * the WHERE is re-evaluated after the wait, so a key that was revoked/retired meanwhile is no
 * longer returned and the caller falls through to the advisory-locked path (which then sees the
 * replacement ACTIVE key).
 */
async function selectActive(tx: Transaction, eventId: string): Promise<SigningKeyRow | undefined> {
  const [row] = await tx
    .select()
    .from(eventSigningKeys)
    .where(and(eq(eventSigningKeys.eventId, eventId), eq(eventSigningKeys.status, 'ACTIVE')))
    .for('share');
  return row;
}

/** Transaction-scoped variant (used by ticket issuance). Creates the ACTIVE key on demand. */
export async function ensureEventSigningKeyTx(
  ctx: CoreContext,
  tx: Transaction,
  eventId: string,
): Promise<TicketSigningKey> {
  const existing = await selectActive(tx, eventId);
  if (existing) return toSigningKey(ctx, existing);
  await tx.execute(lockSql(eventId));
  const afterLock = await selectActive(tx, eventId);
  if (afterLock) return toSigningKey(ctx, afterLock);
  const [event] = await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  return toSigningKey(ctx, await insertActiveKey(ctx, tx, eventId));
}

/** The event's ACTIVE signing key (created on first use). */
export async function ensureEventSigningKey(
  ctx: CoreContext,
  eventId: string,
): Promise<TicketSigningKey> {
  return withTransaction(ctx.db, (tx) => ensureEventSigningKeyTx(ctx, tx, eventId));
}

/**
 * Retires the ACTIVE key and creates a new one. Existing tickets keep verifying (the
 * RETIRED public key stays in `eventPublicKeys`); new tickets are signed with the new key.
 */
export async function rotateEventSigningKey(
  ctx: CoreContext,
  eventId: string,
): Promise<{ retiredKeyId: string | null; newKeyId: string }> {
  return withTransaction(ctx.db, async (tx) => {
    await tx.execute(lockSql(eventId));
    const [event] = await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId));
    if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
    const current = await selectActive(tx, eventId);
    if (current) {
      await tx
        .update(eventSigningKeys)
        .set({ status: 'RETIRED', retiredAt: sql`now()` })
        .where(eq(eventSigningKeys.id, current.id));
    }
    const created = await insertActiveKey(ctx, tx, eventId);
    return { retiredKeyId: current?.keyId ?? null, newKeyId: created.keyId };
  });
}

/**
 * Revokes a key (compromise): QR codes signed with it stop verifying in scanners that sync
 * afterwards. If it was the ACTIVE key a fresh one is created immediately. Returns the number
 * of VALID tickets that still carry the revoked signature and must be re-issued
 * (`reissueTicketsOfRevokedKeys`).
 */
export async function revokeEventSigningKey(
  ctx: CoreContext,
  eventId: string,
  keyId: string,
): Promise<{ affectedTickets: number }> {
  return withTransaction(ctx.db, (tx) => revokeEventSigningKeyTx(ctx, tx, eventId, keyId));
}

/** Transaction-scoped variant of `revokeEventSigningKey` (caller owns the transaction). */
export async function revokeEventSigningKeyTx(
  ctx: CoreContext,
  tx: Transaction,
  eventId: string,
  keyId: string,
): Promise<{ affectedTickets: number }> {
  await tx.execute(lockSql(eventId));
  const [row] = await tx
    .select()
    .from(eventSigningKeys)
    .where(and(eq(eventSigningKeys.eventId, eventId), eq(eventSigningKeys.keyId, keyId)))
    .for('update');
  if (!row) throw new DomainError('SIGNING_KEY_NOT_FOUND', 'Signing key not found', 404);
  if (row.status !== 'REVOKED') {
    await tx
      .update(eventSigningKeys)
      .set({ status: 'REVOKED', revokedAt: sql`now()`, retiredAt: row.retiredAt ?? sql`now()` })
      .where(eq(eventSigningKeys.id, row.id));
    if (row.status === 'ACTIVE') await insertActiveKey(ctx, tx, eventId);
  }
  const [counted] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(eq(tickets.signingKeyId, row.id), eq(tickets.status, 'VALID')));
  return { affectedTickets: counted?.n ?? 0 };
}

/**
 * Revokes EVERY non-revoked key of the event (used when a tested event goes live: all QR codes
 * of test tickets stop verifying) and makes sure a fresh ACTIVE key exists. Returns the number
 * of keys revoked.
 */
export async function revokeAllEventSigningKeysTx(
  ctx: CoreContext,
  tx: Transaction,
  eventId: string,
): Promise<number> {
  await tx.execute(lockSql(eventId));
  const rows = await tx
    .select({ keyId: eventSigningKeys.keyId })
    .from(eventSigningKeys)
    .where(and(eq(eventSigningKeys.eventId, eventId), ne(eventSigningKeys.status, 'REVOKED')));
  for (const row of rows) await revokeEventSigningKeyTx(ctx, tx, eventId, row.keyId);
  return rows.length;
}

/**
 * Public keys a scanner needs for the event. By default ACTIVE and RETIRED keys plus REVOKED
 * ones flagged as such; scanner sync passes `{ excludeRevoked: true }` so a revoked key is
 * never shipped (and never trusted) at all.
 */
export async function eventPublicKeys(
  ctx: CoreContext,
  eventId: string,
  options: { excludeRevoked?: boolean } = {},
): Promise<EventPublicKey[]> {
  return ctx.db
    .select({
      keyId: eventSigningKeys.keyId,
      publicKey: eventSigningKeys.publicKey,
      status: eventSigningKeys.status,
    })
    .from(eventSigningKeys)
    .where(
      options.excludeRevoked
        ? and(eq(eventSigningKeys.eventId, eventId), ne(eventSigningKeys.status, 'REVOKED'))
        : eq(eventSigningKeys.eventId, eventId),
    )
    .orderBy(eventSigningKeys.createdAt);
}
