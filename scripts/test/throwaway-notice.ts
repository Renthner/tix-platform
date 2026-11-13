/** Vitest globalSetup: prints a one-line notice when integration tests will be skipped. */
export default function setup(): void {
  if (process.env.TIX_TEST_THROWAWAY !== '1') {
    console.log(
      '[tix] TIX_TEST_THROWAWAY is not 1 - database/Redis integration tests are skipped. ' +
        'Set it together with TEST_DATABASE_URL / TEST_REDIS_URL pointing at a throw-away server.',
    );
  }
}
