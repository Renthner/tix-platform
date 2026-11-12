# Contributing

Thank you for helping! Bug reports, documentation fixes and pull requests are welcome.

## Licence

TIX is source-available under the [PolyForm Shield License 1.0.0](LICENSE). By contributing you
agree that your contribution is provided under the same licence. Please read the "allowed / not
allowed" summary in the [README](README.md#licence) first.

## Development setup

See [Development in the README](README.md#development): Node.js 24.7+, pnpm, Docker, then
`pnpm install`, `pnpm infra:up`, `pnpm db:migrate && pnpm db:seed`, `pnpm dev`. The Android app
(`apps/android`) is a separate Gradle build, see [apps/android/README.md](apps/android/README.md).

## Before you open a pull request

- `pnpm typecheck` and `pnpm test` pass (`pnpm test` needs a PostgreSQL `TEST_DATABASE_URL`).
- Changes to the shop, checkout or admin UI: run `pnpm test:e2e` (see below).
- Run `pnpm prettier --check` on the files you changed (`pnpm prettier --write` fixes them).
- **Every user-visible text exists in English and German.** Texts live in
  `apps/web/messages/en/*.json` and `apps/web/messages/de/*.json`; `pnpm test` checks that both
  have the same keys. The Android app has `values/` and `values-de/` with the same rule.
- Database changes need a migration (`pnpm db:generate`). Never edit a migration that was
  released.
- Nothing organisation-specific in the repository: no real names, domains, bank data or secrets.
  Business settings belong in the Admin Portal, not in code.
- Update the documentation and add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md)
  when behaviour changes.

## End-to-end tests

`pnpm test:e2e` runs the Playwright suite in `e2e/` (shop, 404 pages, admin, CSP) against an
isolated Docker stack: it builds the web, worker and realtime images of your working tree, starts
them as compose project `tix-e2e` on port 18090 (nothing else on your machine is touched),
creates an admin, seeds the demo event, runs the tests and removes the stack again. Needs Docker,
`pnpm install` and the browser once: `npx playwright install chromium`.

- `E2E_SKIP_BUILD=1` reuses the images of the last run (`tix-e2e/tix-*:local`).
- `E2E_KEEP=1` leaves the stack running afterwards and prints its admin login and the command to
  stop it; run single tests with `pnpm test:e2e -- shop.spec.ts` (arguments go to Playwright).
- `E2E_PORT` changes the HTTP port. In CI the HTML report and traces are uploaded on failure.

## Pull requests

- Keep them small and focused: one topic per pull request.
- Use short, imperative commit messages ("Fix seat release on cart expiry").
- Describe what changed and why, and how you tested it.
- For larger changes open an issue first so we can agree on the approach.

## Security problems

Please do not report them in public issues; see [SECURITY.md](SECURITY.md).
