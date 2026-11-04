#!/bin/sh
# One-shot bootstrap of the S3-compatible object storage (idempotent):
#  - creates the asset bucket (admin uploads: event images, ticket backgrounds, logos)
#  - creates the document bucket (generated PDFs, invoices, .pkpass, bank statements)
#  - creates a least-privilege application user restricted to those two buckets
# Only POSIX sh + mc are available in the client image (no sed/awk).
set -eu

: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}"
: "${S3_ACCESS_KEY_ID:?}" "${S3_SECRET_ACCESS_KEY:?}"
: "${S3_BUCKET_ASSETS:?}" "${S3_BUCKET_DOCUMENTS:?}"

ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"

mc alias set store "$ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

for bucket in "$S3_BUCKET_ASSETS" "$S3_BUCKET_DOCUMENTS"; do
  mc mb --ignore-existing "store/$bucket"
  # No anonymous access: assets and documents are served via short-lived presigned URLs.
  mc anonymous set none "store/$bucket" >/dev/null
done

# Versioning protects generated documents (tickets, invoices) against accidental overwrite.
mc version enable "store/$S3_BUCKET_DOCUMENTS" >/dev/null

POLICY_FILE=/tmp/app-storage-policy.json
cat > "$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET_ASSETS}", "arn:aws:s3:::${S3_BUCKET_DOCUMENTS}"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET_ASSETS}/*", "arn:aws:s3:::${S3_BUCKET_DOCUMENTS}/*"]
    }
  ]
}
JSON

mc admin policy create store app-storage "$POLICY_FILE" >/dev/null
if ! mc admin user info store "$S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
  mc admin user add store "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
fi
USER_INFO="$(mc admin user info store "$S3_ACCESS_KEY_ID")"
case "$USER_INFO" in
  *app-storage*) ;;
  *) mc admin policy attach store app-storage --user "$S3_ACCESS_KEY_ID" >/dev/null ;;
esac

echo "object storage ready: $S3_BUCKET_ASSETS, $S3_BUCKET_DOCUMENTS (user $S3_ACCESS_KEY_ID)"
