# File storage

Uploaded images, invoices, ticket PDFs, wallet passes, bank statements, the scanner APK and the local
backups are stored through one of two drivers. The database always lives in PostgreSQL.

| Driver         | Default for                                      | Files live in                                   |
| -------------- | ------------------------------------------------ | ----------------------------------------------- |
| `fs` (default) | new installations (no `S3_ENDPOINT` set)         | a directory on a mounted volume (`STORAGE_DIR`) |
| `s3`           | installations that set `S3_ENDPOINT` (unchanged) | any S3-compatible service (MinIO, AWS S3, ...)  |

## Environment

| Variable                                   | Default             | Meaning                                                                                      |
| ------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`                           | see below           | `fs` or `s3`. Unset: `s3` when `S3_ENDPOINT` is set, otherwise `fs`.                         |
| `STORAGE_DIR`                              | `/data/storage`     | `fs` only. Must be a persistent volume writable by the application user.                     |
| `S3_ENDPOINT`                              | -                   | `s3` only: URL of the service.                                                               |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | -                   | `s3` only (also as `..._FILE`, see `readSecretEnv`).                                         |
| `S3_BUCKET_ASSETS`, `S3_BUCKET_DOCUMENTS`  | -                   | `s3` only, required. Together with `S3_BUCKET_BACKUPS` they must be three different buckets. |
| `S3_BUCKET_BACKUPS`                        | `tix-backups`       | `s3` only.                                                                                   |
| `S3_REGION`, `S3_FORCE_PATH_STYLE`         | `us-east-1`, `true` | `s3` only.                                                                                   |

Empty values count as unset. The S3 variables are only validated for the `s3` driver.

## Filesystem layout

```
<STORAGE_DIR>/assets/      admin uploads (images, logos, variants)
<STORAGE_DIR>/documents/   invoices, tickets, wallet passes, bank statements, scanner APK
<STORAGE_DIR>/backups/     local backups (backups/<time>-<kind>-<id>/...), pre-update backups, probe history
<STORAGE_DIR>/.meta/       content-type sidecars (one small file per object)
<STORAGE_DIR>/.tmp/        temp files of writes in progress
```

Behaviour: writes are atomic (temp file, fsync, rename), keys are validated (no `..`, no absolute paths, no
backslashes or colons), symbolic links are neither followed nor listed, listing works with plain string
prefixes like S3, a missing object raises `NoSuchKey`. Web and worker (or the processes of the single image)
share the directory; keep `.tmp` on the same volume as the buckets (it is, below `STORAGE_DIR`).

## Trade-offs

- **No object versioning.** MinIO keeps old versions of documents and backups (bucket
  versioning); the filesystem driver does not. Deleting or overwriting a file is final. Use backups.
- **Single node.** All processes must see the same directory. Several hosts need a shared volume with
  reliable rename/fsync semantics (NFS is discouraged); otherwise use S3.
- **Same disk as everything else.** Local backups below `STORAGE_DIR/backups` do not survive the loss of the
  disk. Configure the external backup target (Admin > Backups); the page warns while it is missing.
- Fewer moving parts: no MinIO container, no generated storage credentials, `docker volume` / a bind mount is
  the whole storage. Back up the directory with ordinary tools if you like (the sidecars in `.meta` belong to it).
- Capacity: the disk free-space alert (Admin > Settings > Alerts, "disk paths") should list the storage volume.

## Staying on S3 / MinIO

Existing installations keep working without any change: they set `S3_ENDPOINT`, so the driver is `s3`. To make
this explicit (or to use MinIO / another S3 service on a new installation: `docker-compose.s3.example.yml` in the release bundle) set `STORAGE_DRIVER=s3` and the
`S3_*` variables. There is no automatic migration between drivers and none is needed.

## Switching an installation from S3 to the filesystem

Optional and manual. In outline: stop the shop, copy the objects, change the environment, start. Core ships
the helper `copyBuckets(from, to)` (exported by `@tix/core`; it copies the assets and documents buckets with
content types and skips objects that already exist with the same size; objects whose key the restore/filesystem
validation would reject are not copied and are returned in `rejected`; it has no command line). Create a fresh
backup afterwards - backups made with the S3 driver stay readable (they are encrypted archives; restore
them by uploading them on the Backups page).
