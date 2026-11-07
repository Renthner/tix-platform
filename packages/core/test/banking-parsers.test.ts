/**
 * Statement parsers (camt.053, camt.052, MT940, CSV, ZIP) with real-world-shaped samples,
 * plus money/date helpers and cross-format fingerprints.
 */
import { deflateRawSync } from 'node:zlib';
import { csvProfileSchema } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import {
  detectStatementFormat,
  expandStatementFiles,
  fingerprintBatch,
  parseAmountToCents,
  parseCamt,
  parseCsv,
  parseDate,
  parseMt940,
  parseSepaTags,
  parseStatementFile,
  referenceDistance,
  senderAllowed,
  StatementParseError,
} from '../src';

const OWN_IBAN = 'DE89370400440532013000';
const PAYER_IBAN = 'DE02120300000000202051';
const OTHER_IBAN = 'DE75512108001245126199';
const profile = csvProfileSchema.parse({});

const camt053 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG-0001</MsgId><CreDtTm>2026-03-03T06:00:00+01:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>STMT-2026-03-02</Id>
      <ElctrncSeqNb>42</ElctrncSeqNb>
      <CreDtTm>2026-03-03T06:00:00+01:00</CreDtTm>
      <FrToDt><FrDtTm>2026-03-02T00:00:00+01:00</FrDtTm><ToDtTm>2026-03-02T23:59:59+01:00</ToDtTm></FrToDt>
      <Acct><Id><IBAN>${OWN_IBAN}</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1234.56</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-03-01</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="EUR">49.90</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt>
        <ValDt><Dt>2026-03-02</Dt></ValDt>
        <AcctSvcrRef>2026030212345</AcctSvcrRef>
        <BkTxCd>
          <Domn><Cd>PMNT</Cd><Fmly><Cd>RCDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn>
          <Prtry><Cd>NTRF+166+9310</Cd><Issr>DK</Issr></Prtry>
        </BkTxCd>
        <AddtlNtryInf>GUTSCHRIFT</AddtlNtryInf>
        <NtryDtls>
          <TxDtls>
            <Refs><EndToEndId>E2E-REF-1</EndToEndId><MndtId>NOTPROVIDED</MndtId></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">49.90</Amt></TxAmt></AmtDtls>
            <RltdPties>
              <Dbtr><Nm>Max Mustermann</Nm></Dbtr>
              <DbtrAcct><Id><IBAN>${PAYER_IBAN}</IBAN></Id></DbtrAcct>
              <Cdtr><Nm>Ticket Shop e.V.</Nm></Cdtr>
            </RltdPties>
            <RltdAgts><DbtrAgt><FinInstnId><BIC>TESTDEFFXXX</BIC></FinInstnId></DbtrAgt></RltdAgts>
            <RmtInf><Ustrd>TIX-2026-8492-7 Konzertkarten</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">12.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt>
        <ValDt><Dt>2026-03-02</Dt></ValDt>
        <BkTxCd><Domn><Cd>ACMT</Cd><Fmly><Cd>MDOP</Cd><SubFmlyCd>CHRG</SubFmlyCd></Fmly></Domn></BkTxCd>
        <AddtlNtryInf>ABSCHLUSS</AddtlNtryInf>
        <NtryDtls><TxDtls><RmtInf><Ustrd>Kontoführung März</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">30.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>PDNG</Sts>
        <BookgDt><Dt>2026-03-03</Dt></BookgDt>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">100.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt>
        <ValDt><Dt>2026-03-02</Dt></ValDt>
        <AcctSvcrRef>BATCH-1</AcctSvcrRef>
        <NtryDtls>
          <Btch><NbOfTxs>2</NbOfTxs></Btch>
          <TxDtls>
            <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">60.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Dbtr><Nm>Erika Musterfrau</Nm></Dbtr><DbtrAcct><Id><IBAN>${OTHER_IBAN}</IBAN></Id></DbtrAcct></RltdPties>
            <RmtInf><Ustrd>TIX 2026 1000 0</Ustrd></RmtInf>
          </TxDtls>
          <TxDtls>
            <AmtDtls><TxAmt><Amt Ccy="EUR">40.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Dbtr><Nm>John Doe</Nm></Dbtr></RltdPties>
            <RmtInf><Ustrd>Spende</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

const camt052 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08">
  <BkToCstmrAcctRpt>
    <GrpHdr><MsgId>R-1</MsgId><CreDtTm>2026-03-02T12:00:00+01:00</CreDtTm></GrpHdr>
    <Rpt>
      <Id>RPT-1</Id>
      <Acct><Id><IBAN>${OWN_IBAN}</IBAN></Id></Acct>
      <Ntry>
        <Amt Ccy="EUR">25.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><DtTm>2026-03-02T10:15:00+01:00</DtTm></BookgDt>
        <ValDt><Dt>2026-03-02</Dt></ValDt>
        <NtryDtls><TxDtls>
          <Refs><AcctSvcrRef>X-77</AcctSvcrRef><EndToEndId>TIX-2026-5555-3</EndToEndId></Refs>
          <RltdPties><Dbtr><Pty><Nm>Müller, Hans</Nm></Pty></Dbtr><DbtrAcct><Id><IBAN>${PAYER_IBAN}</IBAN></Id></DbtrAcct></RltdPties>
          <RltdAgts><DbtrAgt><FinInstnId><BICFI>TESTDEFF</BICFI></FinInstnId></DbtrAgt></RltdAgts>
          <RmtInf><Ustrd>Rechnung</Ustrd><Ustrd>Bestellung 123</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">5.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts><Cd>PDNG</Cd></Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt>
      </Ntry>
    </Rpt>
  </BkToCstmrAcctRpt>
</Document>`;

const mt940 = [
  ':20:STARTUMSE',
  ':25:37040044/0532013000',
  ':28C:00001/001',
  ':60F:C260301EUR1234,56',
  ':61:2603020302CR49,90NMSCNONREF//BANKREF1',
  ':86:166?00GUTSCHRIFT?100000?20EREF+E2E-REF-1?21SVWZ+TIX-2026-8492-7 Konzert',
  'karten?30TESTDEFFXXX?31DE02120300000000202051?32Max Mustermann',
  ':61:260302D12,00NMSCNONREF',
  ':86:805?00ABSCHLUSS?20Kontoführung März',
  ':61:2512310102C10,NTRFKREF1',
  ':86:051?00UEBERWEISUNG?20Neujahr?32Erika Musterfrau',
  ':61:260303RC5,00NMSCNONREF',
  ':86:159?00RUECKUEBERWEISUNG?20Retoure',
  ':62F:C260303EUR1277,46',
  '-',
].join('\r\n');

describe('money and date helpers', () => {
  it('parses German and international amounts into cents', () => {
    expect(parseAmountToCents('1.234,56')).toBe(123456);
    expect(parseAmountToCents('-1.234,56 €')).toBe(-123456);
    expect(parseAmountToCents('49,9')).toBe(4990);
    expect(parseAmountToCents('12,', ',')).toBe(1200);
    expect(parseAmountToCents('1,234.50')).toBe(123450);
    expect(parseAmountToCents('49.90', '.')).toBe(4990);
    expect(parseAmountToCents('12.50-')).toBe(-1250);
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
  });

  it('parses dates', () => {
    expect(parseDate('02.03.2026')).toBe('2026-03-02');
    expect(parseDate('02.03.26')).toBe('2026-03-02');
    expect(parseDate('2026-03-02')).toBe('2026-03-02');
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseDate('03/02/2026', 'MM/dd/yyyy')).toBe('2026-03-02');
  });
});

describe('camt.053', () => {
  it('parses booked entries, skips pending ones and splits batches', () => {
    const file = parseCamt(camt053);
    expect(file.format).toBe('CAMT053');
    expect(file.statements).toHaveLength(1);
    const [st] = file.statements;
    expect(st!.statementId).toBe('STMT-2026-03-02');
    expect(st!.accountIdentifier).toBe(OWN_IBAN);
    expect(st!.periodFrom).toBe('2026-03-02');
    expect(st!.periodTo).toBe('2026-03-02');
    expect(st!.transactions).toHaveLength(4);
    const [credit, debit, batchA, batchB] = st!.transactions;
    expect(credit).toMatchObject({
      bookingDate: '2026-03-02',
      valueDate: '2026-03-02',
      amount: 4990,
      currency: 'EUR',
      counterpartyName: 'Max Mustermann',
      counterpartyIban: PAYER_IBAN,
      counterpartyBic: 'TESTDEFFXXX',
      remittanceInformation: 'TIX-2026-8492-7 Konzertkarten',
      endToEndId: 'E2E-REF-1',
      externalId: '2026030212345',
      bankTransactionCode: 'NTRF+166+9310',
      bookingText: 'GUTSCHRIFT',
    });
    expect(debit).toMatchObject({ amount: -1200, bankTransactionCode: 'ACMT/MDOP/CHRG' });
    expect(debit!.remittanceInformation).toBe('Kontoführung März');
    expect(batchA).toMatchObject({
      amount: 6000,
      counterpartyName: 'Erika Musterfrau',
      endToEndId: null,
    });
    expect(batchB).toMatchObject({
      amount: 4000,
      counterpartyName: 'John Doe',
      externalId: 'BATCH-1',
    });
    expect(file.warnings.join(' ')).toMatch(/1 pending/);
  });

  it('rejects DTDs and non-camt XML', () => {
    expect(() => parseCamt('<!DOCTYPE x [<!ENTITY a "b">]><Document/>')).toThrow(
      StatementParseError,
    );
    expect(() => parseCamt('<Document><Foo/></Document>')).toThrow(/Not a camt/);
  });
});

describe('camt.052 (FinTS HKCAZ / intraday report)', () => {
  it('handles v8 status codes, party structures and date-times', () => {
    const file = parseCamt(camt052);
    expect(file.format).toBe('CAMT052');
    const txs = file.statements[0]!.transactions;
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      bookingDate: '2026-03-02',
      amount: 2500,
      counterpartyName: 'Müller, Hans',
      counterpartyBic: 'TESTDEFF',
      endToEndId: 'TIX-2026-5555-3',
      externalId: 'X-77',
      remittanceInformation: 'Rechnung Bestellung 123',
    });
  });
});

describe('MT940', () => {
  it('parses German :86: structures with SEPA tags', () => {
    const file = parseMt940(mt940);
    expect(file.format).toBe('MT940');
    const [st] = file.statements;
    expect(st!.accountIdentifier).toBe('37040044/0532013000');
    expect(st!.statementId).toBe('STARTUMSE/00001/001');
    expect(st!.currency).toBe('EUR');
    const [credit, debit, crossYear, reversal] = st!.transactions;
    expect(credit).toMatchObject({
      bookingDate: '2026-03-02',
      valueDate: '2026-03-02',
      amount: 4990,
      counterpartyName: 'Max Mustermann',
      counterpartyIban: PAYER_IBAN,
      counterpartyBic: 'TESTDEFFXXX',
      remittanceInformation: 'TIX-2026-8492-7 Konzertkarten',
      endToEndId: 'E2E-REF-1',
      externalId: 'BANKREF1',
      bankTransactionCode: '166',
      bookingText: 'GUTSCHRIFT',
    });
    expect(debit).toMatchObject({ amount: -1200, remittanceInformation: 'Kontoführung März' });
    // Value date 2025-12-31, booked 01-02 → year rolls over.
    expect(crossYear).toMatchObject({
      valueDate: '2025-12-31',
      bookingDate: '2026-01-02',
      amount: 1000,
    });
    // RC = reversal of a credit → money leaves the account.
    expect(reversal!.amount).toBe(-500);
  });

  it('extracts SEPA tags', () => {
    const tags = parseSepaTags('EREF+ABCSVWZ+TIX-2026-1-2 TestMREF+M1');
    expect(tags.get('EREF')).toBe('ABC');
    expect(tags.get('SVWZ')).toBe('TIX-2026-1-2 Test');
    expect(tags.get('MREF')).toBe('M1');
  });

  it('skips MT942 interim reports', () => {
    const file = parseMt940(
      ':20:X\n:25:37040044/0532013000\n:28C:1\n:34F:EURD0,\n:61:2603020302C1,00NMSCNONREF\n-',
    );
    expect(file.statements).toHaveLength(0);
    expect(file.warnings[0]).toMatch(/MT942/);
  });
});

describe('CSV', () => {
  const header =
    'Bezeichnung Auftragskonto;IBAN Auftragskonto;BIC Auftragskonto;Bankname Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;BIC (SWIFT-Code) Zahlungsbeteiligter;Buchungstext;Verwendungszweck;Betrag;Waehrung;Saldo nach Buchung;Bemerkung;Kategorie;Steuerrelevant;Glaeubiger ID;Mandatsreferenz';
  const rows = [
    `Girokonto;${OWN_IBAN};TESTDEFFXXX;Testbank;02.03.2026;02.03.2026;Max Mustermann;${PAYER_IBAN};TESTDEFFXXX;Gutschrift;TIX-2026-8492-7 Konzertkarten;49,90;EUR;1.284,46;;;;;`,
    `Girokonto;${OWN_IBAN};TESTDEFFXXX;Testbank;02.03.2026;02.03.2026;Jürgen Müßig;${OTHER_IBAN};;Gutschrift;"Karten; Reihe 3";1.250,00;EUR;2.534,46;;;;;`,
    `Girokonto;${OWN_IBAN};TESTDEFFXXX;Testbank;03.03.2026;03.03.2026;Stadtwerke;${OTHER_IBAN};;Lastschrift;Abschlag;-60,00;EUR;2.474,46;;;;DE98ZZZ09999999999;M-1`,
  ];

  it('detects columns of a German online-banking export (Windows-1252)', () => {
    const bytes = new Uint8Array(Buffer.from([header, ...rows].join('\r\n'), 'latin1'));
    const file = parseStatementFile(
      { fileName: 'Umsaetze.csv', bytes },
      { csvProfile: profile, defaultCurrency: 'EUR' },
    );
    expect(file.format).toBe('CSV');
    const [st] = file.statements;
    expect(st!.accountIdentifier).toBe(OWN_IBAN);
    expect(st!.transactions).toHaveLength(3);
    expect(st!.transactions[0]).toMatchObject({
      bookingDate: '2026-03-02',
      amount: 4990,
      counterpartyName: 'Max Mustermann',
      counterpartyIban: PAYER_IBAN,
      remittanceInformation: 'TIX-2026-8492-7 Konzertkarten',
      bookingText: 'Gutschrift',
    });
    expect(st!.transactions[1]).toMatchObject({
      amount: 125000,
      counterpartyName: 'Jürgen Müßig',
      remittanceInformation: 'Karten; Reihe 3',
    });
    expect(st!.transactions[2]!.amount).toBe(-6000);
  });

  it('uses a configured column mapping and a debit/credit marker', () => {
    const csv = [
      'Export vom 03.03.2026',
      '',
      'Datum,Betrag,Gegenseite,Zweck,S/H,Status',
      '02.03.2026,"49,90",Max Mustermann,TIX-2026-8492-7,H,gebucht',
      '02.03.2026,"10,00",Shop,Retoure,S,gebucht',
      '03.03.2026,"5,00",Max Mustermann,offen,H,vorgemerkt',
    ].join('\n');
    const mapped = csvProfileSchema.parse({
      columns: { remittanceInformation: 'Zweck', creditDebitIndicator: 'S/H' },
      decimalSeparator: ',',
    });
    const file = parseCsv(csv, mapped, 'EUR');
    const txs = file.statements[0]!.transactions;
    expect(txs.map((t) => t.amount)).toEqual([4990, -1000]);
    expect(txs[0]!.remittanceInformation).toBe('TIX-2026-8492-7');
    expect(file.warnings.join(' ')).toMatch(/1 pending/);
  });

  it('reports missing columns', () => {
    expect(() => parseCsv('a;b\n1;2', profile, 'EUR')).toThrow(/columns/);
  });
});

describe('format detection, ZIP archives and fingerprints', () => {
  it('detects formats', () => {
    expect(detectStatementFormat(camt053)).toBe('CAMT053');
    expect(detectStatementFormat(camt052)).toBe('CAMT052');
    expect(detectStatementFormat(mt940)).toBe('MT940');
    expect(detectStatementFormat('Buchungstag;Betrag\n02.03.2026;1,00', 'x.csv')).toBe('CSV');
    expect(() =>
      detectStatementFormat('<?xml version="1.0"?><Document><BkToCstmrDbtCdtNtfctn/></Document>'),
    ).toThrow(/camt.054/);
  });

  it('unpacks ZIP archives (deflate + stored)', () => {
    const zip = buildZip([
      { name: 'day1.xml', data: Buffer.from(camt053), deflate: true },
      { name: '__MACOSX/._day1.xml', data: Buffer.from('x'), deflate: false },
      { name: 'readme.pdf', data: Buffer.from('%PDF'), deflate: false },
      { name: 'day2.sta', data: Buffer.from(mt940), deflate: false },
    ]);
    const files = expandStatementFiles({ fileName: 'export.zip', bytes: zip });
    expect(files.map((f) => f.fileName)).toEqual(['export.zip/day1.xml', 'export.zip/day2.sta']);
    expect(Buffer.from(files[0]!.bytes).toString()).toBe(camt053);
  });

  it('gives the same booking from camt and MT940 the same fingerprint', () => {
    const fromCamt = parseCamt(camt053).statements[0]!.transactions[0]!;
    const fromMt940 = parseMt940(mt940).statements[0]!.transactions[0]!;
    const [a] = fingerprintBatch([fromCamt]);
    const [b] = fingerprintBatch([fromMt940]);
    expect(a).toBe(b);
    // Identical bookings within one batch stay distinct.
    const [x, y] = fingerprintBatch([fromCamt, fromCamt]);
    expect(x).not.toBe(y);
    expect(x).toBe(a);
  });
});

describe('matching helpers', () => {
  it('measures reference distance', () => {
    expect(referenceDistance('TIX-2026-8492-3', 'TIX-2026-8492-7')).toBe('CHECK_DIGIT');
    expect(referenceDistance('TIX-2026-8493-7', 'TIX-2026-8492-7')).toBe('ONE_EDIT');
    expect(referenceDistance('TIX-2026-8429-7', 'TIX-2026-8492-7')).toBe('ONE_EDIT');
    expect(referenceDistance('TIX-2026-849-7', 'TIX-2026-8492-7')).toBe('ONE_EDIT');
    expect(referenceDistance('TIX-2026-1111-7', 'TIX-2026-8492-7')).toBeNull();
    expect(referenceDistance('ABC-2026-8492-7', 'TIX-2026-8492-7')).toBeNull();
  });

  it('checks IMAP sender allow-lists', () => {
    expect(senderAllowed('noreply@bank.example', [])).toBe(true);
    expect(senderAllowed('noreply@bank.example', ['@bank.example'])).toBe(true);
    expect(senderAllowed('NoReply@Bank.Example', ['noreply@bank.example'])).toBe(true);
    expect(senderAllowed('evil@other.example', ['@bank.example'])).toBe(false);
    expect(senderAllowed(null, ['@bank.example'])).toBe(false);
  });
});

/** Tiny ZIP writer for tests (stored / deflated entries). */
function buildZip(entries: { name: string; data: Buffer; deflate: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralDir, end]));
}
