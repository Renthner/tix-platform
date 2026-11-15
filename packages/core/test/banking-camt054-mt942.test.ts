/**
 * camt.054 (debit/credit notification) and MT942 (interim transaction report) parsers.
 * All fixtures are SYNTHETIC, written from the public ISO 20022 / SWIFT / DFÜ format
 * descriptions with example IBANs – no real bank data.
 */
import { deflateRawSync } from 'node:zlib';
import { csvProfileSchema } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import {
  detectStatementFormat,
  expandStatementFiles,
  fingerprintBatch,
  parseCamt,
  parseMt940,
  parseStatementFile,
  StatementParseError,
} from '../src';

const OWN_IBAN = 'DE89370400440532013000';
const PAYER_IBAN = 'DE02120300000000202051';
const profile = csvProfileSchema.parse({});

/** camt.054.001.02 – status as plain string, structured + unstructured remittance, batch. */
const camt054v2 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <BkToCstmrDbtCdtNtfctn>
    <GrpHdr><MsgId>NTF-1</MsgId><CreDtTm>2026-03-02T18:00:00</CreDtTm></GrpHdr>
    <Ntfctn>
      <Id>NTFCTN-2026-03-02-1</Id>
      <Acct><Id><IBAN>${OWN_IBAN}</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Ntry>
        <NtryRef>NR-1</NtryRef>
        <Amt Ccy="EUR">49.90</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt><ValDt><Dt>2026-03-02</Dt></ValDt>
        <AcctSvcrRef>REF-054-1</AcctSvcrRef>
        <BkTxCd><Prtry><Cd>NTRF+166+9310</Cd></Prtry></BkTxCd>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>E2E-054-1</EndToEndId></Refs>
          <RltdPties>
            <Dbtr><Nm>Jürgen Müßig-Äpfel</Nm></Dbtr>
            <DbtrAcct><Id><IBAN>${PAYER_IBAN}</IBAN></Id></DbtrAcct>
          </RltdPties>
          <RltdAgts><DbtrAgt><FinInstnId><BIC>TESTDEFFXXX</BIC></FinInstnId></DbtrAgt></RltdAgts>
          <RmtInf><Ustrd>TIX-2026-8492-7 Konzertkarten</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">12.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <RltdPties><Cdtr><Nm>Stadtwerke</Nm></Cdtr></RltdPties>
          <RmtInf><Ustrd>Abschlag</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>noch offen</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt>
        <NtryDtls>
          <TxDtls>
            <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">60.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Dbtr><Nm>Erika Musterfrau</Nm></Dbtr></RltdPties>
            <RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>TIX-2026-1111-2</Ref></CdtrRefInf></Strd></RmtInf>
          </TxDtls>
          <TxDtls>
            <AmtDtls><TxAmt><Amt Ccy="EUR">40.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Dbtr><Nm>John Doe</Nm></Dbtr></RltdPties>
            <RmtInf><Ustrd>TIX-2026-2222-3</Ustrd><Ustrd>Karten</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Ntfctn>
  </BkToCstmrDbtCdtNtfctn>
</Document>`;

/** camt.054.001.08 – status as <Sts><Cd>, two notifications, namespace prefix, no booking date. */
const camt054v8 = `<?xml version="1.0" encoding="ISO-8859-1"?>
<ns2:Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08">
  <ns2:BkToCstmrDbtCdtNtfctn>
    <ns2:GrpHdr><ns2:MsgId>M</ns2:MsgId><ns2:CreDtTm>2026-03-03T08:00:00+01:00</ns2:CreDtTm></ns2:GrpHdr>
    <ns2:Ntfctn>
      <ns2:Id>A</ns2:Id>
      <ns2:Acct><ns2:Id><ns2:IBAN>${OWN_IBAN}</ns2:IBAN></ns2:Id><ns2:Ccy>EUR</ns2:Ccy></ns2:Acct>
      <ns2:Ntry>
        <ns2:Amt Ccy="EUR">25.00</ns2:Amt><ns2:CdtDbtInd>CRDT</ns2:CdtDbtInd>
        <ns2:Sts><ns2:Cd>BOOK</ns2:Cd></ns2:Sts>
        <ns2:ValDt><ns2:Dt>2026-03-03</ns2:Dt></ns2:ValDt>
        <ns2:NtryDtls><ns2:TxDtls>
          <ns2:Refs><ns2:AcctSvcrRef>TX-8</ns2:AcctSvcrRef></ns2:Refs>
          <ns2:RltdPties><ns2:Dbtr><ns2:Pty><ns2:Nm>Müller, Hans</ns2:Nm></ns2:Pty></ns2:Dbtr></ns2:RltdPties>
          <ns2:RmtInf><ns2:Ustrd>Rechnung &amp; Bestellung 5</ns2:Ustrd></ns2:RmtInf>
        </ns2:TxDtls></ns2:NtryDtls>
      </ns2:Ntry>
      <ns2:Ntry>
        <ns2:CdtDbtInd>CRDT</ns2:CdtDbtInd><ns2:Sts><ns2:Cd>BOOK</ns2:Cd></ns2:Sts>
      </ns2:Ntry>
    </ns2:Ntfctn>
    <ns2:Ntfctn>
      <ns2:Id>B</ns2:Id>
      <ns2:Acct><ns2:Id><ns2:IBAN>${OWN_IBAN}</ns2:IBAN></ns2:Id></ns2:Acct>
      <ns2:Ntry>
        <ns2:Amt Ccy="EUR">1.00</ns2:Amt><ns2:CdtDbtInd>CRDT</ns2:CdtDbtInd>
        <ns2:Sts><ns2:Cd>INFO</ns2:Cd></ns2:Sts>
        <ns2:BookgDt><ns2:Dt>2026-03-03</ns2:Dt></ns2:BookgDt>
      </ns2:Ntry>
    </ns2:Ntfctn>
  </ns2:BkToCstmrDbtCdtNtfctn>
</ns2:Document>`;

const mt942 = [
  ':20:STARTINTRA',
  `:25:37040044/0532013000`,
  ':28C:00002/001',
  ':34F:EURD0,',
  ':34F:EURC0,',
  ':13D:2603021545+0100',
  ':61:2603020302CR49,90NTRFNONREF//BANKREF1',
  `:86:166?00GUTSCHRIFT?10931?20EREF+E2E-REF-1?21SVWZ+TIX-2026-8492-7 Konzertk?22arten?30TESTDEFFXXX?31${PAYER_IBAN}?32Max Mustermann`,
  ':61:260302D12,00NMSCNONREF',
  ':86:805?00ENTGELT?20Kontoführung März?32Testbank',
  ':90D:1EUR12,',
  ':90C:1EUR49,90',
  '-',
].join('\r\n');

/** The equivalent final MT940 of the same two bookings. */
const mt940Final = [
  ':20:STARTUMSE',
  ':25:37040044/0532013000',
  ':28C:00001/001',
  ':60F:C260301EUR1000,00',
  ':61:2603020302CR49,90NTRFNONREF//BANKREF1',
  `:86:166?00GUTSCHRIFT?10931?20EREF+E2E-REF-1?21SVWZ+TIX-2026-8492-7 Konzertk?22arten?30TESTDEFFXXX?31${PAYER_IBAN}?32Max Mustermann`,
  ':61:260302D12,00NMSCNONREF',
  ':86:805?00ENTGELT?20Kontoführung März?32Testbank',
  ':62F:C260302EUR1037,90',
  '-',
].join('\r\n');

describe('camt.054', () => {
  it('parses v2 notifications: credit, debit, pending skipped, batch split', () => {
    const file = parseCamt(camt054v2);
    expect(file.format).toBe('CAMT052');
    expect(file.statements).toHaveLength(1);
    const [st] = file.statements;
    expect(st!.statementId).toBe('NTFCTN-2026-03-02-1');
    expect(st!.accountIdentifier).toBe(OWN_IBAN);
    expect(st!.transactions).toHaveLength(4);
    const [credit, debit, batchA, batchB] = st!.transactions;
    expect(credit).toMatchObject({
      bookingDate: '2026-03-02',
      valueDate: '2026-03-02',
      amount: 4990,
      currency: 'EUR',
      counterpartyName: 'Jürgen Müßig-Äpfel',
      counterpartyIban: PAYER_IBAN,
      counterpartyBic: 'TESTDEFFXXX',
      remittanceInformation: 'TIX-2026-8492-7 Konzertkarten',
      endToEndId: 'E2E-054-1',
      externalId: 'REF-054-1',
      bankTransactionCode: 'NTRF+166+9310',
    });
    expect(credit!.raw).toMatchObject({ source: 'camt054' });
    expect(debit).toMatchObject({ amount: -1200, remittanceInformation: 'Abschlag' });
    expect(batchA).toMatchObject({
      amount: 6000,
      endToEndId: null,
      remittanceInformation: 'TIX-2026-1111-2',
    });
    expect(batchB).toMatchObject({ amount: 4000, remittanceInformation: 'TIX-2026-2222-3 Karten' });
    expect(file.warnings.join(' ')).toMatch(/1 pending/);
  });

  it('parses v8 with namespace prefix, Sts/Cd, latin-1 declaration, value-date fallback', () => {
    const file = parseCamt(camt054v8);
    expect(file.statements).toHaveLength(2);
    const [a, b] = file.statements;
    expect(a!.statementId).toBe('A');
    expect(a!.transactions).toHaveLength(1);
    expect(a!.transactions[0]).toMatchObject({
      bookingDate: '2026-03-03',
      amount: 2500,
      counterpartyName: 'Müller, Hans',
      externalId: 'TX-8',
      remittanceInformation: 'Rechnung & Bestellung 5',
    });
    // INFO status is not booked.
    expect(b!.transactions).toHaveLength(0);
    expect(file.warnings.join(' ')).toMatch(/1 pending/);
    expect(file.warnings.join(' ')).toMatch(/without amount or booking date/);
  });

  it('rejects DTDs, broken XML and other XML documents', () => {
    expect(() => parseCamt('<!DOCTYPE x [<!ENTITY a "b">]><Document/>')).toThrow(
      StatementParseError,
    );
    expect(() => parseCamt('<Document><BkToCstmrDbtCdtNtfctn><Ntfctn>')).toThrow(/Invalid XML/);
    expect(() => parseCamt('<Document><Foo/></Document>')).toThrow(/Not a camt/);
  });

  it('survives a notification without entries or account', () => {
    const file = parseCamt(
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.04"><BkToCstmrDbtCdtNtfctn><Ntfctn><Id>E</Id></Ntfctn></BkToCstmrDbtCdtNtfctn></Document>',
    );
    expect(file.statements[0]!.transactions).toEqual([]);
    expect(file.statements[0]!.accountIdentifier).toBeNull();
  });
});

describe('MT942', () => {
  it('imports the entries, ignores totals, flags them interim', () => {
    const file = parseMt940(mt942);
    expect(file.format).toBe('MT940');
    expect(file.statements).toHaveLength(1);
    const [st] = file.statements;
    expect(st!.accountIdentifier).toBe('37040044/0532013000');
    expect(st!.currency).toBe('EUR');
    expect(st!.statementId).toBe('STARTINTRA/00002/001');
    expect(st!.transactions).toHaveLength(2);
    const [credit, debit] = st!.transactions;
    expect(credit).toMatchObject({
      bookingDate: '2026-03-02',
      amount: 4990,
      counterpartyName: 'Max Mustermann',
      counterpartyIban: PAYER_IBAN,
      remittanceInformation: 'TIX-2026-8492-7 Konzertkarten',
      endToEndId: 'E2E-REF-1',
    });
    expect(credit!.raw).toMatchObject({ source: 'mt942', interim: true });
    expect(debit).toMatchObject({ amount: -1200, remittanceInformation: 'Kontoführung März' });
    expect(file.warnings.join(' ')).toMatch(/MT942/);
  });

  it('splits several MT942 messages and takes the currency from :34F:', () => {
    const two = [
      ':20:A',
      ':25:DE89370400440532013000',
      ':34F:USDD0,',
      ':61:2603020302C1,00NMSCNONREF',
      ':90C:1USD1,',
      '-',
      ':20:B',
      ':25:DE89370400440532013000',
      ':34F:EURD0,',
      ':90D:0EUR0,',
      '-',
    ].join('\n');
    const file = parseMt940(two);
    expect(file.statements).toHaveLength(2);
    expect(file.statements[0]!.currency).toBe('USD');
    expect(file.statements[0]!.transactions).toHaveLength(1);
    expect(file.statements[1]!.transactions).toHaveLength(0);
  });

  it('reports unreadable :61: lines and keeps the readable ones', () => {
    const file = parseMt940(
      [':20:X', ':34F:EURD0,', ':61:garbage', ':61:2603020302C1,00NMSCNONREF', '-'].join('\n'),
    );
    expect(file.statements[0]!.transactions).toHaveLength(1);
    expect(file.warnings.join(' ')).toMatch(/Unreadable :61:/);
  });

  it('an MT942 without any :61: is still recognised', () => {
    expect(detectStatementFormat(':20:X\n:25:1/2\n:34F:EURD0,\n-')).toBe('MT940');
  });
});

describe('detection and cross-format dedupe', () => {
  const asBytes = (s: string) => new Uint8Array(Buffer.from(s));

  it('detects camt.054 and MT942 by content, regardless of extension', () => {
    expect(detectStatementFormat(camt054v2)).toBe('CAMT052');
    expect(detectStatementFormat(camt054v8, 'x.txt')).toBe('CAMT052');
    expect(detectStatementFormat(mt942, 'x.dat')).toBe('MT940');
    expect(detectStatementFormat(':61:2603020302C1,00NMSC', 'umsatz.mt942')).toBe('MT940');
  });

  it('parseStatementFile handles both through auto detection', () => {
    const a = parseStatementFile(
      { fileName: 'n.xml', bytes: asBytes(camt054v2) },
      { csvProfile: profile, defaultCurrency: 'EUR' },
    );
    expect(a.statements[0]!.transactions).toHaveLength(4);
    const b = parseStatementFile(
      { fileName: 'i.942', bytes: asBytes(mt942) },
      { csvProfile: profile, defaultCurrency: 'EUR' },
    );
    expect(b.statements[0]!.transactions).toHaveLength(2);
  });

  it('finds camt.054 / MT942 inside ZIP archives', () => {
    const entries = [
      { name: 'ntf.xml', data: Buffer.from(camt054v2) },
      { name: 'intra.mt942', data: Buffer.from(mt942) },
    ];
    const files = expandStatementFiles({ fileName: 'a.zip', bytes: zipOf(entries) });
    expect(files.map((f) => f.fileName)).toEqual(['a.zip/ntf.xml', 'a.zip/intra.mt942']);
  });

  it('gives the same booking the same fingerprint across camt.054 and MT940, but MT942 its own', () => {
    const fromCamt054 = parseCamt(camt054v2).statements[0]!.transactions[0]!;
    const fromMt942 = parseMt940(mt942).statements[0]!.transactions[0]!;
    const fromMt940 = parseMt940(mt940Final).statements[0]!.transactions[0]!;
    const [a] = fingerprintBatch([fromCamt054]);
    const [b] = fingerprintBatch([fromMt942]);
    const [c] = fingerprintBatch([fromMt940]);
    expect(a).toBe(c);
    // Interim entries must never occupy the fingerprint of the final booking.
    expect(b).not.toBe(c);
  });

  it('flags camt.054 entries without booking date and batch entries', () => {
    const v8 = parseCamt(camt054v8).statements[0]!.transactions[0]!;
    expect(v8.raw).toMatchObject({ noBookingDate: true });
    const withDate = parseCamt(camt054v2).statements[0]!.transactions[0]!;
    expect(withDate.raw?.noBookingDate).toBeUndefined();
    const batch = parseCamt(
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>S</Id>
       <Ntry><Amt Ccy="EUR">70.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-03-12</Dt></BookgDt>
       <NtryDtls><TxDtls><RmtInf><Ustrd>a</Ustrd></RmtInf></TxDtls><TxDtls><RmtInf><Ustrd>b</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
       </Stmt></BkToCstmrStmt></Document>`,
    ).statements[0]!.transactions;
    expect(batch).toHaveLength(1);
    expect(batch[0]!.raw).toMatchObject({ aggregate: true });
  });
});

/** Minimal deflate ZIP writer (central directory included) for the archive test. */
function zipOf(entries: { name: string; data: Buffer }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = deflateRawSync(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBuf, end]));
}
