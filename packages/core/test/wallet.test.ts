import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import {
  buildApplePassJson,
  buildGoogleClass,
  buildGoogleObject,
  buildSaveUrl,
  isoWithOffset,
  packPkpass,
  parseAppleCertificates,
  parseServiceAccountJson,
  signJwt,
  walletTicketPath,
  type AppleWalletConfig,
  type GoogleWalletConfig,
  type ResolvedWalletDesign,
  type WalletTicketData,
} from '../src';
import { readZip } from '../src/wallet/zip';
import { ensureClass, GoogleWalletApiError, isSubset } from '../src/wallet/google';
import { solidPng } from '../src/wallet/png';

function makeChain() {
  const mk = (
    cn: string,
    issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey },
  ) => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01' + Math.floor(Math.random() * 1e6).toString(16);
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
    const attrs = [{ name: 'commonName', value: cn }];
    cert.setSubject(attrs);
    cert.setIssuer(issuer ? issuer.cert.subject.attributes : attrs);
    cert.sign(issuer?.key ?? keys.privateKey, forge.md.sha256.create());
    return { cert, keys };
  };
  const ca = mk('Test WWDR CA');
  const signer = mk('Pass Type ID: pass.test.example', { cert: ca.cert, key: ca.keys.privateKey });
  return {
    wwdrCertificatePem: forge.pki.certificateToPem(ca.cert),
    signerCertificatePem: forge.pki.certificateToPem(signer.cert),
    signerKeyPem: forge.pki.privateKeyToPem(signer.keys.privateKey),
    signerCert: signer.cert,
  };
}

const chain = makeChain();
const config: AppleWalletConfig = {
  passTypeIdentifier: 'pass.test.example',
  teamIdentifier: 'TEAM123456',
  organizationName: 'Test Org',
  signerCertificatePem: chain.signerCertificatePem,
  signerKeyPem: chain.signerKeyPem,
  wwdrCertificatePem: chain.wwdrCertificatePem,
};

const design: ResolvedWalletDesign = {
  backgroundColor: '#112233',
  foregroundColor: '#FFFFFF',
  labelColor: '#CCCCCC',
  logoText: 'Test Show',
  description: null,
  logoAssetId: null,
  iconAssetId: null,
  stripAssetId: null,
  heroAssetId: null,
  sources: [],
};

const ticket = (over: Partial<WalletTicketData> = {}): WalletTicketData => ({
  ticketId: '00000000-0000-4000-8000-000000000002',
  ticketCode: 'ABCDE12345',
  qrPayload: 'tix://v1/k1.AAAA.BBBB.cc.sig',
  attendeeName: 'Alex Sample',
  orderId: '00000000-0000-4000-8000-0000000000aa',
  orderNumber: '2026-000001',
  locale: 'de',
  eventId: '00000000-0000-4000-8000-000000000001',
  eventTitle: 'Sample Musical',
  eventSubtitle: null,
  startsAt: new Date('2027-03-05T18:00:00Z'),
  endsAt: new Date('2027-03-05T21:00:00Z'),
  doorsOpenAt: new Date('2027-03-05T17:00:00Z'),
  timeZone: 'Europe/Berlin',
  googleWalletClassId: null,
  heroImageAssetId: null,
  venueName: 'Town Hall',
  venueAddress: 'Main St 1, 12345 Sample City',
  latitude: 50.1,
  longitude: 8.2,
  kind: 'SEAT',
  block: 'Parkett',
  row: '5',
  seat: '12',
  categoryName: 'Category 1',
  ticketTypeName: 'Regular',
  ...over,
});

describe('Apple pass.json', () => {
  it('contains identifiers, barcode, colours, location and seat fields', () => {
    const json = buildApplePassJson(ticket(), design, config) as Record<string, any>;
    expect(json).toMatchObject({
      formatVersion: 1,
      passTypeIdentifier: 'pass.test.example',
      teamIdentifier: 'TEAM123456',
      organizationName: 'Test Org',
      serialNumber: '00000000-0000-4000-8000-000000000002',
      backgroundColor: 'rgb(17, 34, 51)',
      logoText: 'Test Show',
      relevantDate: '2027-03-05T18:00:00.000Z',
    });
    expect(json.barcodes[0]).toMatchObject({
      format: 'PKBarcodeFormatQR',
      message: 'tix://v1/k1.AAAA.BBBB.cc.sig',
      messageEncoding: 'iso-8859-1',
    });
    expect(json.locations[0]).toMatchObject({ latitude: 50.1, longitude: 8.2 });
    const aux = json.eventTicket.auxiliaryFields.map((f: any) => [f.key, f.value]);
    expect(aux).toContainEqual(['block', 'Parkett']);
    expect(aux).toContainEqual(['seat', '12']);
  });

  it('omits the block when show_label_on_ticket is off and locations without coordinates', () => {
    const json = buildApplePassJson(
      ticket({ block: null, latitude: null, longitude: null }),
      design,
      config,
    ) as Record<string, any>;
    const keys = json.eventTicket.auxiliaryFields.map((f: any) => f.key);
    expect(keys).not.toContain('block');
    expect(JSON.stringify(json)).not.toContain('Parkett');
    expect(json.locations).toBeUndefined();
  });

  it('uses a generic place for standing tickets', () => {
    const json = buildApplePassJson(
      ticket({ kind: 'GENERAL_ADMISSION', seat: null, row: null, block: null }),
      design,
      config,
    ) as Record<string, any>;
    expect(json.eventTicket.auxiliaryFields[0]).toMatchObject({ key: 'place', value: 'Stehplatz' });
  });
});

describe('.pkpass package', () => {
  it('has a manifest matching all files and a valid detached PKCS#7 signature', () => {
    const certs = parseAppleCertificates(config);
    const passJson = buildApplePassJson(ticket(), design, config);
    const bytes = packPkpass(
      passJson,
      [
        { name: 'icon.png', bytes: solidPng(29, '#112233') },
        { name: 'icon@2x.png', bytes: solidPng(58, '#112233') },
      ],
      certs,
    );
    const files = readZip(bytes);
    expect([...files.keys()].sort()).toEqual(
      ['icon.png', 'icon@2x.png', 'manifest.json', 'pass.json', 'signature'].sort(),
    );
    const manifest = JSON.parse(files.get('manifest.json')!.toString()) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(['icon.png', 'icon@2x.png', 'pass.json']);
    for (const [name, hash] of Object.entries(manifest)) {
      expect(createHash('sha1').update(files.get(name)!).digest('hex')).toBe(hash);
    }
    expect(JSON.parse(files.get('pass.json')!.toString()).serialNumber).toBe(
      '00000000-0000-4000-8000-000000000002',
    );

    // Signature: messageDigest attribute = SHA-1(manifest), RSA signature over the attributes.
    const msg = forge.pkcs7.messageFromAsn1(
      forge.asn1.fromDer(forge.util.createBuffer(files.get('signature')!.toString('binary'))),
    ) as any;
    expect(msg.certificates).toHaveLength(2);
    const attrs = msg.rawCapture.authenticatedAttributes as forge.asn1.Asn1[];
    const digestAttr = attrs.find(
      (a) => forge.asn1.derToOid((a.value as any)[0].value) === forge.pki.oids.messageDigest,
    )!;
    const digest = ((digestAttr.value as any)[1].value as forge.asn1.Asn1[])[0]!.value as string;
    expect(Buffer.from(digest, 'binary').toString('hex')).toBe(
      createHash('sha1').update(files.get('manifest.json')!).digest('hex'),
    );
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const signed = forge.asn1.toDer(set).getBytes();
    const verifier = createVerify('RSA-SHA1').update(Buffer.from(signed, 'binary'));
    expect(
      verifier.verify(
        forge.pki.certificateToPem(chain.signerCert),
        Buffer.from(msg.rawCapture.signature as string, 'binary'),
      ),
    ).toBe(true);
  });

  it('rejects a key that does not match the certificate and unreadable PEMs', () => {
    const other = makeChain();
    expect(() => parseAppleCertificates({ ...config, signerKeyPem: other.signerKeyPem })).toThrow(
      /does not belong/,
    );
    expect(() => parseAppleCertificates({ ...config, wwdrCertificatePem: 'nope' })).toThrow(/WWDR/);
    expect(() => parseAppleCertificates({ ...config, signerKeyPem: 'nope' })).toThrow(
      /private key/,
    );
  });
});

describe('Google Wallet payloads', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const gConfig: GoogleWalletConfig = {
    issuerId: '3388000000000000001',
    classPrefix: 'tix',
    organizationName: 'Test Org',
    clientEmail: 'svc@test.iam.gserviceaccount.com',
    privateKey: pem,
    tokenUri: 'https://oauth2.googleapis.com/token',
  };

  it('signs a skinny save-to-wallet JWT that verifies with the public key', () => {
    const url = buildSaveUrl(gConfig, `${gConfig.issuerId}.tix_abc`, 'https://shop.example', 1000);
    expect(url.startsWith('https://pay.google.com/gp/v/save/')).toBe(true);
    const jwt = url.slice('https://pay.google.com/gp/v/save/'.length);
    expect(jwt.length).toBeLessThan(1800);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iss: gConfig.clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: 1000,
      origins: ['https://shop.example'],
      payload: { eventTicketObjects: [{ id: `${gConfig.issuerId}.tix_abc` }] },
    });
    expect(
      createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')),
    ).toBe(true);
    expect(signJwt({ a: 1 }, pem).split('.')).toHaveLength(3);
  });

  it('builds class and object', () => {
    const data = ticket();
    const cls = buildGoogleClass(
      gConfig,
      data,
      design,
      { logo: null, hero: 'https://x/h' },
      'en',
    ) as any;
    expect(cls.id).toBe(`${gConfig.issuerId}.tix_${data.eventId}`);
    expect(cls.reviewStatus).toBe('UNDER_REVIEW');
    expect(cls.dateTime.start).toBe('2027-03-05T19:00:00+01:00');
    expect(cls.dateTime.doorsOpen).toBe('2027-03-05T18:00:00+01:00');
    expect(cls.heroImage.sourceUri.uri).toBe('https://x/h');
    expect(cls.locations[0].latitude).toBe(50.1);
    expect(cls.customRowLabel).toEqual({
      defaultValue: { language: 'en', value: 'Row' },
      translatedValues: [{ language: 'de', value: 'Reihe' }],
    });
    expect(cls.customSeatLabel.translatedValues[0].value).toBe('Platz');
    expect(cls.customSectionLabel.translatedValues[0].value).toBe('Block');
    expect(cls.customGateLabel.translatedValues[0].value).toBe('Eingang');
    const de = buildGoogleClass(gConfig, data, design, { logo: null, hero: null }, 'de') as any;
    expect(de.customRowLabel.defaultValue).toEqual({ language: 'de', value: 'Reihe' });
    expect(de.customRowLabel.translatedValues).toEqual([{ language: 'en', value: 'Row' }]);

    const obj = buildGoogleObject(gConfig, data) as any;
    expect(obj).toMatchObject({
      id: `${gConfig.issuerId}.tix_${data.ticketId}`,
      state: 'ACTIVE',
      barcode: { type: 'QR_CODE', value: data.qrPayload },
      ticketHolderName: 'Alex Sample',
    });
    expect(obj.seatInfo.seat.defaultValue.value).toBe('12');
    expect(obj.seatInfo.section.defaultValue.value).toBe('Parkett');
    const hidden = buildGoogleObject(gConfig, ticket({ block: null })) as any;
    expect(hidden.seatInfo.section).toBeUndefined();
  });

  it('parses service account keys and formats offsets', () => {
    expect(
      parseServiceAccountJson(JSON.stringify({ client_email: 'a@b', private_key: 'k' })),
    ).toMatchObject({ clientEmail: 'a@b', tokenUri: 'https://oauth2.googleapis.com/token' });
    expect(() => parseServiceAccountJson('{')).toThrow(/JSON/);
    expect(() => parseServiceAccountJson('{}')).toThrow(/client_email/);
    expect(isoWithOffset(new Date('2027-07-01T10:00:00Z'), 'Europe/Berlin')).toBe(
      '2027-07-01T12:00:00+02:00',
    );
    expect(isoWithOffset(new Date('2027-07-01T10:00:00Z'), 'UTC')).toMatch(
      /T10:00:00(\+00:00|Z)?$/,
    );
  });

  describe('Google class sync (restart scenario)', () => {
    const body = () =>
      buildGoogleClass(gConfig, ticket(), design, { logo: null, hero: null }, 'en') as Record<
        string,
        unknown
      >;
    const harness = (existing: { status: number; json?: unknown }) => {
      const calls: { method: string; body?: any }[] = [];
      const fake = async (url: string, init?: RequestInit) => {
        if (url.includes('oauth2')) return Response.json({ access_token: 'tok', expires_in: 3600 });
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        if (method === 'GET')
          return Response.json(existing.json ?? {}, { status: existing.status });
        return Response.json({});
      };
      return { calls, fake };
    };

    it('inserts with UNDER_REVIEW when the class does not exist', async () => {
      const { calls, fake } = harness({ status: 404 });
      await ensureClass(gConfig, fake, 'cls-new', body());
      expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
      expect(calls[1]!.body.reviewStatus).toBe('UNDER_REVIEW');
    });

    it('sends nothing when the approved class is unchanged', async () => {
      const { calls, fake } = harness({
        status: 200,
        json: { ...body(), reviewStatus: 'APPROVED', extra: 1 },
      });
      await ensureClass(gConfig, fake, 'cls-same', body());
      expect(calls.map((c) => c.method)).toEqual(['GET']);
    });

    it('patches an existing class that lacks the custom labels once', async () => {
      const { customRowLabel, customSeatLabel, customSectionLabel, customGateLabel, ...legacy } =
        body() as Record<string, unknown>;
      void [customRowLabel, customSeatLabel, customSectionLabel, customGateLabel];
      const { calls, fake } = harness({
        status: 200,
        json: { ...legacy, reviewStatus: 'APPROVED' },
      });
      await ensureClass(gConfig, fake, 'cls-legacy', body());
      expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
      expect(calls[1]!.body.reviewStatus).toBe('UNDER_REVIEW');
      expect(calls[1]!.body.customRowLabel.defaultValue.value).toBe('Row');
    });

    it('patches an approved but changed class with UNDER_REVIEW, never APPROVED', async () => {
      const { calls, fake } = harness({
        status: 200,
        json: { ...body(), reviewStatus: 'APPROVED', hexBackgroundColor: '#000001' },
      });
      await ensureClass(gConfig, fake, 'cls-changed', body());
      expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
      expect(calls[1]!.body.reviewStatus).toBe('UNDER_REVIEW');
    });

    it('surfaces API errors and compares subsets', async () => {
      const { fake } = harness({ status: 500, json: { error: { message: 'boom' } } });
      await expect(ensureClass(gConfig, fake, 'cls-err', body())).rejects.toBeInstanceOf(
        GoogleWalletApiError,
      );
      expect(isSubset({ a: [1, { b: 2 }] }, { a: [1, { b: 2, c: 3 }], d: 4 })).toBe(true);
      expect(isSubset({ a: [1] }, { a: [1, 2] })).toBe(false);
    });
  });
});

describe('wallet routes', () => {
  it('builds ticket paths with the order token', () => {
    expect(walletTicketPath('o1', 't1', 'pkpass', 'a b')).toBe(
      '/api/orders/o1/tickets/t1/pkpass?t=a%20b',
    );
    expect(walletTicketPath('o1', 't1', 'google')).toBe('/api/orders/o1/tickets/t1/google');
  });
});
