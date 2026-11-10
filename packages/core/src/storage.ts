import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** Logical buckets: admin uploads (images, logos) and generated/received documents. */
export type StorageBucket = 'assets' | 'documents';

export interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  buckets: Record<StorageBucket, string>;
}

/**
 * S3-compatible object storage (MinIO in the default stack). Documents (invoices, statement
 * files, tickets) are private and always streamed through the app after an access check.
 */
export class ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: ObjectStorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async put(
    bucket: StorageBucket,
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.buckets[bucket],
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(
    bucket: StorageBucket,
    key: string,
  ): Promise<{ body: Uint8Array; contentType: string | undefined }> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.buckets[bucket], Key: key }),
    );
    if (!res.Body) throw new Error(`Object ${bucket}/${key} has no body`);
    return { body: await res.Body.transformToByteArray(), contentType: res.ContentType };
  }

  /** All objects below `prefix` (follows pagination). */
  async list(
    bucket: StorageBucket,
    prefix: string,
  ): Promise<{ key: string; lastModified: Date | undefined }[]> {
    const out: { key: string; lastModified: Date | undefined }[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.buckets[bucket],
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(bucket: StorageBucket, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.buckets[bucket], Key: key }),
    );
  }
}

/** Storage from the standard S3_* environment variables. */
export function objectStorageFromEnv(env: {
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_BUCKET_ASSETS: string;
  S3_BUCKET_DOCUMENTS: string;
  S3_FORCE_PATH_STYLE: boolean | string;
}): ObjectStorage {
  return new ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === true || env.S3_FORCE_PATH_STYLE === 'true',
    buckets: { assets: env.S3_BUCKET_ASSETS, documents: env.S3_BUCKET_DOCUMENTS },
  });
}
