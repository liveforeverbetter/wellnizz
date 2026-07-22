import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { RawSourceReference } from '../types.js';

// Direct-upload session contract returned by S3-compatible stores. The client
// sends the file straight to object storage, so it never passes through a CDN
// or the API process (and therefore cannot hit their request-body limits).
export interface SignedPayloadUpload {
  object_key: string;
  bucket_name: string;
  upload_url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expires_in_seconds: number;
}

// Server-generated object key: `<org>/<user>/<source>/<sanitized-filename>`.
export function payloadKey(source: Pick<RawSourceReference, 'id' | 'user_id' | 'filename'>, organizationId: string): string {
  const filename = (source.filename ?? `${source.id}.bin`).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
  return `${organizationId}/${source.user_id}/${source.id}/${filename}`;
}

export function geneticUploadPayloadKey(source: Pick<RawSourceReference, 'id' | 'user_id' | 'filename'>, organizationId: string): string {
  return payloadKey(source, organizationId);
}

// Source payloads (VCFs, biomarker CSVs, lab PDFs) are opaque blobs keyed by a
// server-generated object key of the form `<org>/<user>/<source>/<filename>`.
// Two drivers back them: a mounted-volume filesystem store (the zero-dependency
// default) and an S3-compatible store (MinIO or any S3) for deployments that
// want object storage. Selected by STORAGE_DRIVER.
export interface PayloadStore {
  readonly driver: 'filesystem' | 's3';
  upload(objectKey: string, payload: Buffer, contentType?: string): Promise<void>;
  // Streaming upload from a local file, so large artifacts (e.g. a multi-hundred-MB
  // dbSNP-annotated VCF) are not buffered wholesale in the process.
  uploadFile(objectKey: string, filePath: string, contentType?: string): Promise<void>;
  download(objectKey: string): Promise<Buffer | undefined>;
  writeToFile(objectKey: string, destination: string): Promise<boolean>;
  size(objectKey: string): Promise<number | undefined>;
  remove(objectKey: string): Promise<void>;
  readiness(): Promise<{ ok: boolean; detail: string }>;
}

export function configuredPayloadStore(env: NodeJS.ProcessEnv = process.env): PayloadStore {
  const driver = (env.STORAGE_DRIVER ?? 'filesystem').toLowerCase();
  if (driver === 's3') return new S3PayloadStore(env);
  if (driver === 'filesystem' || driver === 'fs' || driver === 'local') return new FilesystemPayloadStore(env);
  throw new Error(`Unsupported STORAGE_DRIVER "${driver}". Use "filesystem" or "s3".`);
}

export class FilesystemPayloadStore implements PayloadStore {
  readonly driver = 'filesystem' as const;
  private readonly base: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.base = resolve(env.PAYLOAD_DIR ?? '/data/payloads');
  }

  async upload(objectKey: string, payload: Buffer): Promise<void> {
    const path = this.pathFor(objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, payload);
  }

  async uploadFile(objectKey: string, filePath: string): Promise<void> {
    const path = this.pathFor(objectKey);
    await mkdir(dirname(path), { recursive: true });
    await pipeline(createReadStream(filePath), createWriteStream(path));
  }

  async download(objectKey: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.pathFor(objectKey));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async writeToFile(objectKey: string, destination: string): Promise<boolean> {
    const path = this.pathFor(objectKey);
    try {
      await pipeline(createReadStream(path), createWriteStream(destination));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async size(objectKey: string): Promise<number | undefined> {
    try {
      return (await stat(this.pathFor(objectKey))).size;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async remove(objectKey: string): Promise<void> {
    await rm(this.pathFor(objectKey), { force: true });
  }

  async readiness(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(this.base, { recursive: true });
      const probe = join(this.base, '.readiness');
      await writeFile(probe, '');
      await rm(probe, { force: true });
      return { ok: true, detail: `filesystem:${this.base}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Object keys are generated server-side, but resolve-and-verify defends against
  // any future caller passing a key with `..` segments that would escape the
  // payload volume.
  private pathFor(objectKey: string): string {
    const path = resolve(this.base, objectKey);
    if (isAbsolute(objectKey) || (path !== this.base && !path.startsWith(this.base + sep))) {
      throw new Error(`Invalid payload object key: ${objectKey}`);
    }
    return path;
  }
}

export class S3PayloadStore implements PayloadStore {
  readonly driver = 's3' as const;
  private readonly bucket: string;
  private clientPromise?: Promise<S3Client>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    // Accept Fly Tigris's auto-provisioned var names (BUCKET_NAME/AWS_*) as
    // fallbacks so `fly storage create` works with no extra configuration.
    const bucket = env.S3_BUCKET ?? env.STORAGE_BUCKET ?? env.BUCKET_NAME;
    if (!bucket) throw new Error('S3_BUCKET (or BUCKET_NAME) is required when STORAGE_DRIVER=s3.');
    this.bucket = bucket;
  }

  async upload(objectKey: string, payload: Buffer, contentType?: string): Promise<void> {
    const { client, PutObjectCommand } = await this.sdk();
    await client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      Body: payload,
      ContentType: contentType ?? 'application/octet-stream',
    }));
  }

  async uploadFile(objectKey: string, filePath: string, contentType?: string): Promise<void> {
    const { client, PutObjectCommand } = await this.sdk();
    // Stream from disk with an explicit ContentLength so PutObject accepts a
    // non-buffered body and the large annotated VCF never loads into memory.
    const { size } = await stat(filePath);
    await client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType ?? 'application/octet-stream',
    }));
  }

  async download(objectKey: string): Promise<Buffer | undefined> {
    const body = await this.getBody(objectKey);
    if (!body) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  async writeToFile(objectKey: string, destination: string): Promise<boolean> {
    const body = await this.getBody(objectKey);
    if (!body) return false;
    await pipeline(body, createWriteStream(destination));
    return true;
  }

  async size(objectKey: string): Promise<number | undefined> {
    const { client, HeadObjectCommand } = await this.sdk();
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return typeof head.ContentLength === 'number' ? head.ContentLength : undefined;
    } catch (error) {
      if (isS3NotFound(error)) return undefined;
      throw error;
    }
  }

  async remove(objectKey: string): Promise<void> {
    const { client, DeleteObjectCommand } = await this.sdk();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  async readiness(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { client, HeadBucketCommand } = await this.sdk();
      await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, detail: `s3:${this.bucket}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Creates a short-lived, object-scoped PUT URL. This is deliberately a
   * single-object upload rather than a proxy endpoint: genomics files can be
   * hundreds of megabytes and must not traverse Cloudflare or the API server.
   */
  async createSignedPayloadUpload(objectKey: string, contentType = 'application/octet-stream'): Promise<SignedPayloadUpload> {
    const { client, PutObjectCommand } = await this.sdk();
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const expiresIn = signedUploadExpirySeconds(this.env);
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
    }), { expiresIn });

    return {
      object_key: objectKey,
      bucket_name: this.bucket,
      upload_url: uploadUrl,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expires_in_seconds: expiresIn,
    };
  }

  /**
   * Short-lived, object-scoped GET URL. Lets a client download a large stored
   * object (e.g. the complete WGS analysis) straight from object storage,
   * bypassing the API server so it never buffers the blob in its 1 GB heap.
   */
  async createSignedPayloadDownload(objectKey: string): Promise<{ download_url: string; expires_in_seconds: number }> {
    const { client, GetObjectCommand } = await this.sdk();
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const expiresIn = signedUploadExpirySeconds(this.env);
    const download_url = await getSignedUrl(client, new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }), { expiresIn });
    return { download_url, expires_in_seconds: expiresIn };
  }

  private async getBody(objectKey: string): Promise<Readable | undefined> {
    const { client, GetObjectCommand } = await this.sdk();
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return result.Body ? (result.Body as Readable) : undefined;
    } catch (error) {
      if (isS3NotFound(error)) return undefined;
      throw error;
    }
  }

  private async sdk() {
    const mod = await import('@aws-sdk/client-s3');
    if (!this.clientPromise) {
      const endpoint = this.env.S3_ENDPOINT ?? this.env.AWS_ENDPOINT_URL_S3;
      const accessKeyId = this.env.S3_ACCESS_KEY_ID ?? this.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = this.env.S3_SECRET_ACCESS_KEY ?? this.env.AWS_SECRET_ACCESS_KEY;
      this.clientPromise = Promise.resolve(new mod.S3Client({
        region: this.env.S3_REGION ?? this.env.AWS_REGION ?? 'us-east-1',
        endpoint,
        // Path-style addressing is required for MinIO and most self-hosted S3.
        forcePathStyle: (this.env.S3_FORCE_PATH_STYLE ?? 'true').toLowerCase() !== 'false',
        credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      }));
    }
    const client = await this.clientPromise;
    return {
      client,
      PutObjectCommand: mod.PutObjectCommand,
      GetObjectCommand: mod.GetObjectCommand,
      HeadObjectCommand: mod.HeadObjectCommand,
      HeadBucketCommand: mod.HeadBucketCommand,
      DeleteObjectCommand: mod.DeleteObjectCommand,
    };
  }
}

type S3Client = import('@aws-sdk/client-s3').S3Client;

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isS3NotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error == null) return false;
  const name = (error as { name?: string; $metadata?: { httpStatusCode?: number } });
  return name.name === 'NotFound' || name.name === 'NoSuchKey' || name.$metadata?.httpStatusCode === 404;
}

function signedUploadExpirySeconds(env: NodeJS.ProcessEnv): number {
  const requested = Number(env.GENETICS_UPLOAD_URL_TTL_SECONDS ?? 3600);
  if (!Number.isFinite(requested)) return 3600;
  return Math.min(Math.max(Math.floor(requested), 60), 86_400);
}
