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
[docs/RELEASES.md](docs/RELEASES.md#verifying-releases).
