# Security policy

## Supported versions

Only the latest release receives security fixes. While TIX is in pre-release
(`1.0.0-alpha.N`), that is the newest pre-release; after `1.0.0` it is the latest stable release.
Please update before you report a problem.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately with GitHub Security Advisories:

1. Open <https://github.com/Renthner/tix-platform/security/advisories/new>
   (or the **Security** tab of the repository and **Report a vulnerability**).
2. Describe the problem, the affected version and how to reproduce it. Do not include real
   customer data, passwords or keys.

You will get an answer as soon as possible. Please give us reasonable time to fix the problem
before you publish details.

## Verifying what you run

Releases are built by a GitHub workflow; images are signed with cosign, the APK, compose file and
deploy bundle carry build attestations. See
[docs/RELEASES.md](../docs/RELEASES.md#verifying-releases).

## Deployment hardening

Set `TRUSTED_PROXIES` to the exact IP/CIDR of your TLS reverse proxy and publish port 8080 only on the
interface that proxy uses; TIX warns at startup about risky values. The built-in proxy answers 421 to
foreign `Host` headers (`TIX_ALLOWED_HOSTS`) and limits connections and request time
(`TIX_PROXY_*`); every internal process receives only the secrets it needs. See
[docs/INSTALL.md](../docs/INSTALL.md#built-in-proxy-host-check-and-limits).

Restoring a backup executes its SQL as the database user. Restoring a backup of **another system** (entering
its encryption key) is therefore off unless the operator sets `TIX_ALLOW_FOREIGN_BACKUP_KEYS=1`; with it on, a
SUPER_ADMIN effectively has database-superuser power (arbitrary SQL, e.g. `COPY ... PROGRAM`). Enable it only
temporarily for a migration. See [docs/BACKUP.md](../docs/BACKUP.md#restoring-a-backup-from-another-system).

## Admin sign-in

Passkeys, mandatory two-factor authentication and the recovery paths are described in
[docs/ADMIN-SECURITY.md](../docs/ADMIN-SECURITY.md).

## Libraries that parse untrusted data

Two dependencies are no longer actively maintained upstream or have a history of parser bugs, so TIX keeps
their exposure small:

- **pdf-lib** (unmaintained) only **creates** PDFs (tickets, invoices, reports); it never opens a PDF supplied
  by a user (`PDFDocument.load` is used in tests only). The only external input it parses are the PNG / JPEG
  images of ticket designs, uploaded by signed-in administrators; WebP images are converted to PNG by `sharp`
  first, and an image that cannot be embedded is skipped with a log warning instead of failing the ticket.
  Customer-supplied text is drawn as text, never interpreted. Fonts are the bundled Noto Sans.
- **node-forge** is used for Apple Wallet only: it parses the signing certificate, the WWDR certificate and the
  private key that an administrator enters in the settings, and signs the pass. It never processes data from
  shop visitors.

If you do not use Apple Wallet, leave it unconfigured and node-forge is never invoked. Every parse error of
these inputs is caught and reported in the admin or the log; the container runs with all capabilities dropped
and `no-new-privileges` (see the release `docker-compose.yml`), which limits the damage of a parser bug.
