#!/bin/sh
# One-shot bootstrap of the S3-compatible object storage (idempotent):
#  - creates the asset bucket (admin uploads: event images, ticket backgrounds, logos)
#  - creates the document bucket (generated PDFs, invoices, .pkpass, bank statements)
#  - creates the backup bucket (encrypted full backups: database dump + all files)
#  - creates a least-privilege application user restricted to those three buckets
# Only POSIX sh + mc are available in the client image (no sed/awk).
set -eu

# Credentials come from files written by the storage-credentials service (<NAME>_FILE); a plain
# variable of the same name wins (manual runs). The value is the first line of the file, trimmed.
read_secret() {
  _secret=""
  IFS= read -r _secret < "$1" || [ -n "$_secret" ] || { echo "cannot read $1" >&2; exit 1; }
  # Trim surrounding whitespace like MinIO and the app (readSecretEnv) do.
  _secret="${_secret#"${_secret%%[![:space:]]*}"}"
  _secret="${_secret%"${_secret##*[![:space:]]}"}"
  printf '%s' "$_secret"
}
if [ -z "${MINIO_ROOT_USER:-}" ]; then MINIO_ROOT_USER="$(read_secret "${MINIO_ROOT_USER_FILE:?MINIO_ROOT_USER or MINIO_ROOT_USER_FILE}")"; fi
if [ -z "${MINIO_ROOT_PASSWORD:-}" ]; then MINIO_ROOT_PASSWORD="$(read_secret "${MINIO_ROOT_PASSWORD_FILE:?MINIO_ROOT_PASSWORD or MINIO_ROOT_PASSWORD_FILE}")"; fi
if [ -z "${S3_ACCESS_KEY_ID:-}" ]; then S3_ACCESS_KEY_ID="$(read_secret "${S3_ACCESS_KEY_ID_FILE:?S3_ACCESS_KEY_ID or S3_ACCESS_KEY_ID_FILE}")"; fi
if [ -z "${S3_SECRET_ACCESS_KEY:-}" ]; then S3_SECRET_ACCESS_KEY="$(read_secret "${S3_SECRET_ACCESS_KEY_FILE:?S3_SECRET_ACCESS_KEY or S3_SECRET_ACCESS_KEY_FILE}")"; fi
: "${S3_BUCKET_ASSETS:?}" "${S3_BUCKET_DOCUMENTS:?}" "${S3_BUCKET_BACKUPS:?}"

ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"

mc alias set store "$ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

for bucket in "$S3_BUCKET_ASSETS" "$S3_BUCKET_DOCUMENTS" "$S3_BUCKET_BACKUPS"; do
  mc mb --ignore-existing "store/$bucket"
  # No anonymous access: assets and documents are served via short-lived presigned URLs.
  mc anonymous set none "store/$bucket" >/dev/null
done

# Versioning protects generated documents (tickets, invoices) against accidental overwrite.
# Backups are versioned too: a deleted or overwritten archive stays recoverable server-side.
for bucket in "$S3_BUCKET_DOCUMENTS" "$S3_BUCKET_BACKUPS"; do
  mc version enable "store/$bucket" >/dev/null
done

POLICY_FILE=/tmp/app-storage-policy.json
cat > "$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET_ASSETS}", "arn:aws:s3:::${S3_BUCKET_DOCUMENTS}", "arn:aws:s3:::${S3_BUCKET_BACKUPS}"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET_ASSETS}/*", "arn:aws:s3:::${S3_BUCKET_DOCUMENTS}/*", "arn:aws:s3:::${S3_BUCKET_BACKUPS}/*"]
    }
  ]
}
JSON

mc admin policy create store app-storage "$POLICY_FILE" >/dev/null
# `user add` on an existing user replaces its secret: the stored secret always wins.
mc admin user add store "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
USER_INFO="$(mc admin user info store "$S3_ACCESS_KEY_ID")"
case "$USER_INFO" in
  *app-storage*) ;;
  *) mc admin policy attach store app-storage --user "$S3_ACCESS_KEY_ID" >/dev/null ;;
esac

echo "object storage ready: $S3_BUCKET_ASSETS, $S3_BUCKET_DOCUMENTS, $S3_BUCKET_BACKUPS (user $S3_ACCESS_KEY_ID)"
