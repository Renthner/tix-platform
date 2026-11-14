import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';

// Runs with the stored admin session (see auth.setup.ts). Uploads an image and checks that the
// shop serves it as AVIF / WebP variants (`<picture>`), with strict parameter validation.

/** A real 1600 x 900 RGB gradient PNG (no image library needed in the test runner). */
function gradientPng(width = 1600, height = 900): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const o = y * row;
    raw[o] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o + 1 + x * 3] = Math.floor((x / width) * 255);
      raw[o + 2 + x * 3] = Math.floor((y / height) * 255);
      raw[o + 3 + x * 3] = (x * 7 + y * 3) & 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function eventAdminUrl(page: Page): Promise<string> {
  await page.goto('/admin/events');
  const link = page.locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' }).first();
  const href = await link.getAttribute('href');
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  expect(id, 'demo event id').toBeTruthy();
  return `/admin/events/${id}`;
}

test('uploaded images are served as AVIF / WebP variants and used as <picture>', async ({
  page,
  request,
}) => {
  // 1. Upload through the admin API.
  const upload = await request.post('/api/admin/media', {
    multipart: {
      kind: 'EVENT_IMAGE',
      file: { name: 'e2e-cover.png', mimeType: 'image/png', buffer: gradientPng() },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const { asset } = (await upload.json()) as { asset: { id: string; width: number } };
  expect(asset.width).toBe(1600);

  // 2. Variant delivery: the worker generates the variants after the upload, so poll. Until
  // then the original answers with a short cache lifetime; afterwards allow-listed width +
  // format, immutable caching, correct type.
  const variantUrl = `/api/media/${asset.id}?w=640&f=avif`;
  // The variant may exist before the whole asset is finished; it is only immutable afterwards.
  await expect
    .poll(
      async () => {
        const res = await request.get(variantUrl);
        return `${res.headers()['content-type']} ${res.headers()['cache-control']}`;
      },
      { timeout: 60_000, intervals: [500, 1000, 2000] },
    )
    .toMatch(/^image\/avif .*immutable/);
  const avif = await request.get(variantUrl);
  expect(avif.status()).toBe(200);
  const webp = await request.get(`/api/media/${asset.id}?w=640&f=webp`);
  expect(webp.headers()['content-type']).toBe('image/webp');
  const small = (await avif.body()).length;
  const original = await request.get(`/api/media/${asset.id}`);
  expect(original.headers()['content-type']).toBe('image/png');
  expect(small).toBeLessThan((await original.body()).length);
  // A source narrower than the request answers with its widest variant.
  const widest = await request.get(`/api/media/${asset.id}?w=2560&f=avif`);
  expect(widest.status()).toBe(200);
  expect(widest.headers()['content-type']).toBe('image/avif');
  expect(widest.headers()['cache-control']).toContain('immutable');
  // Conditional request.
  const etag = avif.headers().etag!;
  const cached = await request.get(`/api/media/${asset.id}?w=640&f=avif`, {
    headers: { 'if-none-match': etag },
  });
  expect(cached.status()).toBe(304);

  // 3. Strict parameter validation.
  for (const q of ['w=641&f=avif', 'w=640&f=png', 'w=640', 'w=abc&f=webp', 'f=', 'w=-1&f=avif']) {
    expect((await request.get(`/api/media/${asset.id}?${q}`)).status(), q).toBe(400);
  }

  // 4. Use it as the cover of the demo event (admin form) ...
  await page.goto(await eventAdminUrl(page));
  const form = page.locator('form', { has: page.locator('input[name=heroImageAssetId]') });
  await form.locator('input[type=file]').setInputFiles({
    name: 'e2e-cover.png',
    mimeType: 'image/png',
    buffer: gradientPng(),
  });
  await expect(form.locator('input[name=heroImageAssetId]')).not.toHaveValue('');
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/admin/events/'),
  );
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();

  // ... and check the shop renders <picture> with AVIF + WebP sources.
  await page.goto('/');
  const card = page.getByTestId('event-card').first();
  await expect(card.locator('picture source[type="image/avif"]')).toHaveCount(1);
  await expect(card.locator('picture source[type="image/webp"]')).toHaveCount(1);
  const srcset = await card.locator('picture source[type="image/avif"]').getAttribute('srcset');
  expect(srcset).toMatch(/\?w=320&f=avif 320w/);
  expect(await card.locator('picture img').getAttribute('src')).toMatch(
    /^\/api\/media\/[0-9a-f-]{36}$/,
  );

  await page.goto('/events/demo-concert');
  const cover = page.locator('picture:has(source[type="image/avif"]) img').first();
  await expect(cover).toHaveAttribute('fetchpriority', 'high');
  await expect(cover).toHaveAttribute('loading', 'eager');
  // The browser actually picks the AVIF source (Chromium supports it).
  await expect
    .poll(async () => cover.evaluate((img: HTMLImageElement) => img.currentSrc))
    .toMatch(/f=avif/);
});
