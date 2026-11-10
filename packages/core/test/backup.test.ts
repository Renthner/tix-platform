import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BackupCryptoError,
  backupManifestSchema,
  collect,
  decryptStream,
  encryptStream,
  isBackupDue,
  latestScheduledSlot,
  mergeSequenceCounters,
  readArchive,
  selectBackupsToDelete,
  sequenceRaises,
  writeArchive,
  type ArchiveEntry,
  type BackupKey,
} from '../src';
import { compareRowCounts } from '../src/backup/verify';
import { carryForwardSql, errorLinesOnly } from '../src/backup/pg';
import { isNonPublicAddress } from '../src/backup/endpoint-guard';

async function* from(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield p;
}
async function bytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  return collect(stream, Number.MAX_SAFE_INTEGER);
}

const key = (id = 'k1'): BackupKey => ({ id, key: randomBytes(32) });

describe('backup encryption (streaming AES-256-GCM)', () => {
  const plain = randomBytes(10_000);

  it('round-trips data of several chunks', async () => {
    const k = key();
    const encrypted = await bytes(
      encryptStream(from(plain.subarray(0, 3_000), plain.subarray(3_000)), k, 1_024),
    );
    expect(encrypted.length).toBeGreaterThan(plain.length);
    expect(await bytes(decryptStream(from(encrypted), [k]))).toEqual(plain);
  });

  it('round-trips empty input and an exact multiple of the chunk size', async () => {
    const k = key();
    for (const size of [0, 1_024, 2_048]) {
      const data = randomBytes(size);
      const enc = await bytes(encryptStream(from(data), k, 1_024));
      expect(await bytes(decryptStream(from(enc), [k]))).toEqual(data);
    }
  });

  it('is not deterministic (fresh salt and nonce prefix)', async () => {
    const k = key();
    const a = await bytes(encryptStream(from(plain), k));
    const b = await bytes(encryptStream(from(plain), k));
    expect(a.equals(b)).toBe(false);
  });

  it('decrypts with the key id from the header out of a key ring', async () => {
    const old = key('k1');
    const current = key('k2');
    const enc = await bytes(encryptStream(from(plain), old));
    expect(await bytes(decryptStream(from(enc), [current, old]))).toEqual(plain);
  });

  it('rejects a wrong key, an unknown key id and foreign files', async () => {
    const k = key();
    const enc = await bytes(encryptStream(from(plain), k));
    await expect(
      bytes(decryptStream(from(enc), [{ id: 'k1', key: randomBytes(32) }])),
    ).rejects.toMatchObject({
      code: 'CORRUPT',
    });
    await expect(bytes(decryptStream(from(enc), [key('other')]))).rejects.toMatchObject({
      code: 'KEY_UNKNOWN',
    });
    await expect(
      bytes(decryptStream(from(Buffer.from('hello world, not a backup')), [k])),
    ).rejects.toMatchObject({
      code: 'NOT_A_BACKUP',
    });
  });

  it('detects a flipped bit anywhere after the header', async () => {
    const k = key();
    const enc = await bytes(encryptStream(from(plain), k, 1_024));
    for (const position of [enc.length - 1, Math.floor(enc.length / 2), 60]) {
      const tampered = Buffer.from(enc);
      tampered[position] = tampered[position]! ^ 0x01;
      await expect(bytes(decryptStream(from(tampered), [k]))).rejects.toBeInstanceOf(
        BackupCryptoError,
      );
    }
  });

  it('detects truncation at a chunk boundary and mid-chunk', async () => {
    const k = key();
    const enc = await bytes(encryptStream(from(plain), k, 1_024));
    const frame = 4 + 1_024 + 16;
    const headerLength = 8 + 1 + 2 + 16 + 4;
    const atBoundary = enc.subarray(0, headerLength + frame * 3);
    await expect(bytes(decryptStream(from(atBoundary), [k]))).rejects.toMatchObject({
      code: 'TRUNCATED',
    });
    await expect(
      bytes(decryptStream(from(enc.subarray(0, enc.length - 5)), [k])),
    ).rejects.toMatchObject({
      code: 'TRUNCATED',
    });
  });

  it('detects swapped chunks and trailing garbage', async () => {
    const k = key();
    const enc = await bytes(encryptStream(from(randomBytes(4_096)), k, 1_024));
    const frame = 4 + 1_024 + 16;
    const headerLength = 8 + 1 + 2 + 16 + 4;
    const swapped = Buffer.from(enc);
    enc.copy(swapped, headerLength, headerLength + frame, headerLength + 2 * frame);
    enc.copy(swapped, headerLength + frame, headerLength, headerLength + frame);
    await expect(bytes(decryptStream(from(swapped), [k]))).rejects.toMatchObject({
      code: 'CORRUPT',
    });
    await expect(
      bytes(decryptStream(from(Buffer.concat([enc, Buffer.from([1])])), [k])),
    ).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('works when the ciphertext arrives in tiny pieces', async () => {
    const k = key();
    const enc = await bytes(encryptStream(from(plain), k, 1_024));
    async function* drip() {
      for (let i = 0; i < enc.length; i += 7) yield enc.subarray(i, i + 7);
    }
    expect(await bytes(decryptStream(drip(), [k]))).toEqual(plain);
  });
});

describe('backup archive container', () => {
  async function* entries(list: { name: string; data: Buffer }[]): AsyncGenerator<ArchiveEntry> {
    for (const e of list) {
      yield { header: { name: e.name, size: e.data.length }, data: from(e.data) };
    }
  }

  it('round-trips entries, including empty ones and long names', async () => {
    const long = `files/documents/${'a/'.repeat(120)}file.pdf`;
    const list = [
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'db.dump', data: randomBytes(2_500_000) },
      { name: long, data: Buffer.alloc(0) },
      { name: 'files/assets/x.png', data: randomBytes(10) },
    ];
    const archive = await bytes(writeArchive(entries(list)));
    const seen: { name: string; data: Buffer }[] = [];
    for await (const entry of readArchive(from(archive))) {
      seen.push({ name: entry.header.name, data: await bytes(entry.data) });
    }
    expect(seen).toEqual(list);
  });

  it('skips unread entry data and survives an early stop', async () => {
    const list = [
      { name: 'a', data: randomBytes(3_000) },
      { name: 'b', data: randomBytes(3_000) },
    ];
    const archive = await bytes(writeArchive(entries(list)));
    const names: string[] = [];
    for await (const entry of readArchive(from(archive))) names.push(entry.header.name);
    expect(names).toEqual(['a', 'b']);
    for await (const entry of readArchive(from(archive))) {
      for await (const _chunk of entry.data) break; // stop after the first frame
    }
  });

  it('fails without a terminator', async () => {
    const archive = await bytes(writeArchive(entries([{ name: 'a', data: randomBytes(10) }])));
    await expect(
      (async () => {
        for await (const e of readArchive(from(archive.subarray(0, archive.length - 4))))
          await bytes(e.data);
      })(),
    ).rejects.toBeInstanceOf(BackupCryptoError);
  });

  it('works through encryption end to end', async () => {
    const k = key();
    const list = [{ name: 'db.dump', data: randomBytes(300_000) }];
    const enc = await bytes(encryptStream(writeArchive(entries(list)), k, 64 * 1024));
    const out: Buffer[] = [];
    for await (const e of readArchive(decryptStream(from(enc), [k]))) out.push(await bytes(e.data));
    expect(out[0]).toEqual(list[0]!.data);
  });
});

describe('manifest', () => {
  const base = {
    formatVersion: 1,
    id: randomUUID(),
    kind: 'MANUAL',
    createdAt: '2026-11-09T10:00:00.000Z',
    appVersion: '0.1.0',
    lastMigration: { when: 1_700_000_000_000, tag: '0001_x', count: 2 },
    postgresVersion: '18.1',
    encryption: { algorithm: 'AES-256-GCM-STREAM', keyId: 'k1' },
    rowCounts: { orders: 3 },
  };
  it('accepts a minimal inner manifest and a complete one', () => {
    expect(backupManifestSchema.parse(base).createdByUserId).toBeNull();
    expect(
      backupManifestSchema.parse({
        ...base,
        archive: { sizeBytes: 10, sha256: 'a'.repeat(64) },
        database: { dumpBytes: 5 },
        files: { assets: { objects: 1, bytes: 2 }, documents: { objects: 0, bytes: 0 } },
      }).archive?.sizeBytes,
    ).toBe(10);
  });
  it('rejects wrong versions, kinds and checksums', () => {
    expect(() => backupManifestSchema.parse({ ...base, formatVersion: 2 })).toThrow();
    expect(() => backupManifestSchema.parse({ ...base, kind: 'OTHER' })).toThrow();
    expect(() =>
      backupManifestSchema.parse({ ...base, archive: { sizeBytes: 1, sha256: 'short' } }),
    ).toThrow();
  });
  it('compares row counts', () => {
    expect(compareRowCounts({ a: 1, b: 2 }, { a: 1, b: 2, c: 9 })).toEqual([]);
    expect(compareRowCounts({ a: 1, b: 2 }, { a: 1 })).toHaveLength(1);
  });
});

describe('schedule (shop time zone, DST safe)', () => {
  const berlin = 'Europe/Berlin';
  const daily = (time: string) => ({ frequency: 'DAILY' as const, weekday: 1, time });
  const iso = (d: Date) => d.toISOString();

  it('finds the latest daily slot (winter, UTC+1)', () => {
    expect(iso(latestScheduledSlot(daily('03:00'), berlin, new Date('2026-01-15T10:00:00Z')))).toBe(
      '2026-01-15T02:00:00.000Z',
    );
    expect(iso(latestScheduledSlot(daily('03:00'), berlin, new Date('2026-01-15T01:00:00Z')))).toBe(
      '2026-01-14T02:00:00.000Z',
    );
  });

  it('finds the latest weekly slot on the configured weekday', () => {
    // 2026-01-15 is a Thursday; Monday (1) 03:00 local = 02:00Z on the 12th.
    expect(
      iso(
        latestScheduledSlot(
          { frequency: 'WEEKLY', weekday: 1, time: '03:00' },
          berlin,
          new Date('2026-01-15T10:00:00Z'),
        ),
      ),
    ).toBe('2026-01-12T02:00:00.000Z');
    // Sunday (0).
    expect(
      iso(
        latestScheduledSlot(
          { frequency: 'WEEKLY', weekday: 0, time: '03:00' },
          berlin,
          new Date('2026-01-15T10:00:00Z'),
        ),
      ),
    ).toBe('2026-01-11T02:00:00.000Z');
  });

  it('runs a slot inside the spring-forward gap right after the gap', () => {
    // 2026-03-29: 02:00 -> 03:00 does not exist in Berlin; 02:30 becomes 03:30 CEST = 01:30Z.
    expect(iso(latestScheduledSlot(daily('02:30'), berlin, new Date('2026-03-29T05:00:00Z')))).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('uses the first occurrence in the fall-back overlap and never runs twice', () => {
    // 2026-10-25: 02:30 happens at 00:30Z (CEST) and 01:30Z (CET).
    const now = new Date('2026-10-25T01:45:00Z');
    const slot = latestScheduledSlot(daily('02:30'), berlin, now);
    expect(iso(slot)).toBe('2026-10-25T00:30:00.000Z');
    expect(isBackupDue(daily('02:30'), berlin, now, slot)).toBe(false);
    expect(isBackupDue(daily('02:30'), berlin, now, new Date('2026-10-24T00:30:00Z'))).toBe(true);
  });

  it('is due once per slot and skips slots missed by more than the catch-up window', () => {
    const cfg = daily('03:00');
    const now = new Date('2026-01-15T02:00:30Z');
    expect(isBackupDue(cfg, berlin, now, null)).toBe(true);
    expect(isBackupDue(cfg, berlin, now, new Date('2026-01-14T02:00:05Z'))).toBe(true);
    expect(isBackupDue(cfg, berlin, now, new Date('2026-01-15T02:00:05Z'))).toBe(false);
    expect(isBackupDue(cfg, berlin, new Date('2026-01-15T12:00:00Z'), null)).toBe(false);
  });

  it('honours other time zones', () => {
    expect(
      iso(
        latestScheduledSlot(daily('03:00'), 'America/New_York', new Date('2026-07-01T12:00:00Z')),
      ),
    ).toBe('2026-07-01T07:00:00.000Z');
  });
});

describe('retention and number counters', () => {
  const b = (kind: 'MANUAL' | 'SCHEDULED' | 'PRE_RESTORE', day: number, verifiedOk = false) => ({
    id: `${kind}-${day}`,
    kind,
    createdAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
    verifiedOk,
  });
  const now = new Date(Date.UTC(2026, 5, 1));

  it('keeps the newest N scheduled backups; manual and safety backups stay by default', () => {
    const all = [
      ...[1, 2, 3, 4, 5].map((d) => b('SCHEDULED', d)),
      ...[1, 2, 3, 4].map((d) => b('PRE_RESTORE', d)),
      ...[1, 2, 3].map((d) => b('MANUAL', d)),
    ];
    const doomed = selectBackupsToDelete(all, { scheduled: 2, manualMaxAgeDays: 0 }, now);
    expect(doomed.sort()).toEqual(['SCHEDULED-1', 'SCHEDULED-2', 'SCHEDULED-3']);
  });

  it('never deletes the newest verified backup, even when unverified ones fill the quota', () => {
    const all = [b('SCHEDULED', 1, true), b('SCHEDULED', 2), b('SCHEDULED', 3), b('SCHEDULED', 4)];
    expect(selectBackupsToDelete(all, { scheduled: 2, manualMaxAgeDays: 0 }, now)).toEqual([
      'SCHEDULED-2',
    ]);
  });

  it('applies the age limit to manual and safety backups only when it is set', () => {
    const all = [b('MANUAL', 1), b('PRE_RESTORE', 2), b('SCHEDULED', 3)];
    // 2026-06-01 minus 30 days: all January backups are older.
    expect(selectBackupsToDelete(all, { scheduled: 5, manualMaxAgeDays: 30 }, now).sort()).toEqual([
      'MANUAL-1',
      'PRE_RESTORE-2',
    ]);
    expect(selectBackupsToDelete(all, { scheduled: 5, manualMaxAgeDays: 0 }, now)).toEqual([]);
    // The newest verified one survives the age limit.
    expect(
      selectBackupsToDelete([b('MANUAL', 1, true)], { scheduled: 5, manualMaxAgeDays: 30 }, now),
    ).toEqual([]);
  });

  it('deletes nothing when below the limits', () => {
    expect(
      selectBackupsToDelete([b('SCHEDULED', 1)], { scheduled: 5, manualMaxAgeDays: 0 }, now),
    ).toEqual([]);
  });

  it('carries number counters forward: max(live, restored)', () => {
    const live = new Map([
      ['invoice:2026', 120],
      ['order:2026', 500],
      ['credit:2026', 4],
    ]);
    const restored = new Map([
      ['invoice:2026', 100],
      ['order:2026', 510],
      ['old:2025', 9],
    ]);
    const merged = mergeSequenceCounters(live, restored);
    expect(merged.get('invoice:2026')).toBe(120);
    expect(merged.get('order:2026')).toBe(510);
    expect(merged.get('credit:2026')).toBe(4);
    expect(merged.get('old:2025')).toBe(9);
    expect(sequenceRaises(live, restored).sort((a, c) => a.scope.localeCompare(c.scope))).toEqual([
      { scope: 'credit:2026', value: 4 },
      { scope: 'invoice:2026', value: 120 },
    ]);
  });
});

describe('pg helpers', () => {
  it('keeps only error lines of tool output (no CONTEXT / DETAIL row data)', () => {
    const stderr = [
      'psql: error: connection failed',
      'ERROR:  duplicate key value violates unique constraint "x"',
      'DETAIL:  Key (email)=(jane@example.org) already exists.',
      'CONTEXT:  COPY customers, line 3: "jane@example.org"',
      'Command was: COPY public.customers FROM stdin;',
    ].join('\n');
    const out = errorLinesOnly(stderr);
    expect(out).toContain('duplicate key');
    expect(out).not.toContain('jane@example.org');
    expect(out).not.toContain('COPY');
  });

  it('builds carry-forward SQL with escaped identifiers and literals', () => {
    const sql = carryForwardSql({
      counters: new Map([["invoice:20'26", 12]]),
      sequences: new Map([['ticket_sync_version_seq', 99]]),
    });
    expect(sql).toContain("VALUES ('invoice:20''26', 12)");
    expect(sql).toContain('GREATEST(public.number_sequences.last_value, EXCLUDED.last_value)');
    expect(sql).toContain('\'public."ticket_sync_version_seq"\'');
    expect(sql).toContain('GREATEST(99');
  });
});

describe('endpoint guard', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.0.9',
    '172.16.0.1',
    '100.64.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::1',
    '2002:a9fe:a9fe::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    'not-an-ip',
  ];
  const allowed = [
    '8.8.8.8',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2002:808:808::',
  ];
  it.each(blocked)('blocks %s', (a) => expect(isNonPublicAddress(a)).toBe(true));
  it.each(allowed)('allows %s', (a) => expect(isNonPublicAddress(a)).toBe(false));
});
