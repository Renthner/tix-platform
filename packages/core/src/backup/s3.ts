import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { guardedLookup } from './endpoint-guard';

export interface S3BucketConfig {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  bucket: string;
  /**
   * Set for the external target: connections are only made to public addresses (checked at
   * connect time, which defeats DNS rebinding) unless the admin allowed private networks.
   */
  guard?: { allowPrivateNetwork: boolean };
}

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

const PART_BYTES = 8 * 1024 * 1024;

/**
 * Streaming access to one S3-compatible bucket (local MinIO or the external backup target).
 * Everything that can be large is streamed: listing is paged, downloads are readable streams,
 * uploads are multipart with a bounded buffer of one part.
 */
export class S3Bucket {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: S3BucketConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Some S3-compatible providers reject the SDK's default CRC32 trailer checksums.
      ...(config.guard
        ? {
            requestHandler: {
              httpAgent: new HttpAgent({
                lookup: guardedLookup(config.guard.allowPrivateNetwork) as never,
              }),
              httpsAgent: new HttpsAgent({
                lookup: guardedLookup(config.guard.allowPrivateNetwork) as never,
              }),
            },
          }
        : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async *list(prefix: string): AsyncGenerator<S3ObjectInfo> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key) yield { key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  /** Immediate "sub-directories" below `prefix` (prefix of each returned entry ends with `/`). */
  async listDirectories(prefix: string): Promise<string[]> {
    const dirs: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: token,
        }),
      );
      for (const p of page.CommonPrefixes ?? []) if (p.Prefix) dirs.push(p.Prefix);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return dirs;
  }

  async getStream(
    key: string,
  ): Promise<{ stream: AsyncIterable<Uint8Array>; size: number; contentType?: string }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object ${this.bucket}/${key} has no body`);
    return {
      stream: res.Body as unknown as AsyncIterable<Uint8Array>,
      size: res.ContentLength ?? 0,
      contentType: res.ContentType,
    };
  }

  async getBytes(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object ${this.bucket}/${key} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  /** Bytes of an object or null when it does not exist. */
  async tryGetBytes(key: string): Promise<Buffer | null> {
    try {
      return await this.getBytes(key);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putBytes(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1_000) {
      const batch = keys.slice(i, i + 1_000);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (res.Errors?.length) {
        throw new Error(
          `Deleting ${res.Errors.length} object(s) failed: ${res.Errors[0]?.Message}`,
        );
      }
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys: string[] = [];
    for await (const o of this.list(prefix)) keys.push(o.key);
    await this.deleteMany(keys);
    return keys.length;
  }

  /**
   * Multipart upload of a stream of unknown length. Bounded memory (one part); aborted on any
   * error so no orphaned parts stay behind. Returns size and SHA-256 of what was written.
   */
  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    contentType = 'application/octet-stream',
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!UploadId) throw new Error('Multipart upload could not be started');
    const parts: CompletedPart[] = [];
    let buffered: Buffer[] = [];
    let bufferedBytes = 0;
    const flush = async (): Promise<void> => {
      const body = Buffer.concat(buffered);
      buffered = [];
      bufferedBytes = 0;
      const PartNumber = parts.length + 1;
      const res = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId,
          PartNumber,
          Body: body,
          ContentLength: body.length,
        }),
      );
      parts.push({ ETag: res.ETag, PartNumber });
    };
    try {
      for await (const piece of source) {
        const buf = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
        hash.update(buf);
        sizeBytes += buf.length;
        buffered.push(buf);
        bufferedBytes += buf.length;
        // Part size grows with the part count so 10,000 parts reach far beyond 1 TB.
        if (bufferedBytes >= PART_BYTES * (1 + Math.floor(parts.length / 1_000))) await flush();
      }
      if (bufferedBytes > 0 || parts.length === 0) await flush();
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (err) {
      await this.client
        .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId }))
        .catch(() => undefined);
      throw err;
    }
    return { sizeBytes, sha256: hash.digest('hex') };
  }

  /** Connectivity + permission check: head, write, read and delete a small probe object. */
  async checkAccess(probeKey: string): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    const payload = `tix-backup-probe ${new Date().toISOString()}`;
    await this.putBytes(probeKey, payload, 'text/plain');
    const back = (await this.getBytes(probeKey)).toString('utf8');
    await this.delete(probeKey);
    if (back !== payload) throw new Error('Probe object read back differently');
  }

  destroy(): void {
    this.client.destroy();
  }
}

export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** The three local buckets used by backups. */
export interface BackupBuckets {
  assets: S3Bucket;
  documents: S3Bucket;
  backups: S3Bucket;
}

export function backupBucketsFromEnv(env: {
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_BUCKET_ASSETS: string;
  S3_BUCKET_DOCUMENTS: string;
  S3_BUCKET_BACKUPS: string;
  S3_FORCE_PATH_STYLE: boolean | string;
}): BackupBuckets {
  const base = {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === true || env.S3_FORCE_PATH_STYLE === 'true',
  };
  return {
    assets: new S3Bucket({ ...base, bucket: env.S3_BUCKET_ASSETS }),
    documents: new S3Bucket({ ...base, bucket: env.S3_BUCKET_DOCUMENTS }),
    backups: new S3Bucket({ ...base, bucket: env.S3_BUCKET_BACKUPS }),
  };
}
