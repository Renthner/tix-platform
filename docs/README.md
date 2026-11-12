# Documentation

English | [Deutsch](README.de.md)

## For operators

| Document                       | Content                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [INSTALL.md](INSTALL.md)       | Install TIX on a Linux server step by step, HTTPS variants, troubleshooting (also [in German](INSTALL.de.md)) |
| [BACKUP.md](BACKUP.md)         | What a backup contains, schedule, external S3 target, restore                                                 |
| [RELEASES.md](RELEASES.md)     | Version scheme, channels (`next`, `stable`), verifying downloads, updates                                     |
| [ACCOUNTING.md](ACCOUNTING.md) | Accounting export (DATEV, CSV) and bookkeeping rules                                                          |
| [SCANNER.md](SCANNER.md)       | Check-in device API, pairing, sync rules                                                                      |
| [LOAD-TEST.md](LOAD-TEST.md)   | How the load test works and how to run it                                                                     |

## For developers

| Document                                                   | Content                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                         | Monorepo layout, services, design decisions                |
| [DATABASE.md](DATABASE.md)                                 | PostgreSQL schema, states, constraints                     |
| [REDIS.md](REDIS.md)                                       | Redis keys, Lua scripts for seat locks, queue, rate limits |
| [TICKETS.md](TICKETS.md)                                   | Ticket QR format, Ed25519 signatures, test vector          |
| [../apps/android/README.md](../apps/android/README.md)     | Check-in app: build, architecture, publishing updates      |
| [../apps/android/docs/LAN.md](../apps/android/docs/LAN.md) | LAN master protocol of the check-in app                    |
| [../CONTRIBUTING.md](../CONTRIBUTING.md)                   | How to contribute                                          |
| [../SECURITY.md](../SECURITY.md)                           | Reporting vulnerabilities                                  |
| [../CHANGELOG.md](../CHANGELOG.md)                         | Changes per release                                        |
