import { expect, test } from '@playwright/test';

// The ticket designer preview loads the PDF font from the app itself (same font as the PDF).
test.describe('bundled fonts', () => {
  for (const file of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf']) {
    test(`${file} is served with a long cache`, async ({ request }) => {
      const res = await request.get(`/api/fonts/${file}?v=1`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('font/ttf');
      expect(res.headers()['cache-control']).toContain('immutable');
      expect((await res.body()).length).toBeGreaterThan(100_000);
    });
  }

  test('unknown font file is a 404', async ({ request }) => {
    const res = await request.get('/api/fonts/secret.ttf');
    expect(res.status()).toBe(404);
  });
});
