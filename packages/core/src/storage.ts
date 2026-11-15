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
 * Object storage used by the application (assets, documents). Documents (invoices, statement
 * files, tickets) are private and always streamed through the app after an access check.
 * Missing objects raise an error named `NoSuchKey` (or `NotFound`, HTTP-404 `$metadata`).
 * Implementations: {@link S3ObjectStorage} and `FsObjectStorage` (storage-fs.ts).
 */
export interface ObjectStorage {
  readonly driver: 'fs' | 's3';
  put(
    bucket: StorageBucket,
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<void>;
  get(
    bucket: StorageBucket,
    key: string,
  ): Promise<{ body: Uint8Array; contentType: string | undefined }>;
  /** The object as a web stream (no full buffering in memory). */
  getStream(
    bucket: StorageBucket,
    key: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | undefined }>;
  /** All objects whose key starts with `prefix` (plain string prefix, ascending key order). */
  list(
    bucket: StorageBucket,
    prefix: string,
  ): Promise<{ key: string; lastModified: Date | undefined }[]>;
  /** Deleting a missing key is not an error. */
  delete(bucket: StorageBucket, key: string): Promise<void>;
}

/** S3-compatible object storage (MinIO in the bundled stack, or any S3 service). */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
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

  /** The object as a web stream (no full buffering in memory). */
  async getStream(
    bucket: StorageBucket,
    key: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | undefined }> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.buckets[bucket], Key: key }),
    );
    if (!res.Body) throw new Error(`Object ${bucket}/${key} has no body`);
    return { stream: res.Body.transformToWebStream(), contentType: res.ContentType };
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
