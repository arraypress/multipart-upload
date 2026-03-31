import type { Hono, Context } from 'hono';

export interface UploadConfig {
  /** R2 bucket binding or function returning one. */
  bucket: object | ((c: Context) => object);
  /** Prefix for object keys. Default: 'uploads/' */
  keyPrefix?: string;
  /** Optional Hono auth middleware. */
  auth?: Function;
  /** Callback after upload completes. Return value is included in response. */
  onComplete?: (info: CompleteInfo) => Promise<Record<string, unknown> | void>;
}

export interface CompleteInfo {
  key: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  hashSha256: string;
  metadata: Record<string, string>;
  env: unknown;
}

export interface UploadFileParams {
  /** File to upload. */
  file: File;
  /** Base URL of upload routes (e.g. '/api/upload'). */
  baseUrl: string;
  /** Chunk size in bytes. Default: 5MB. */
  chunkSize?: number;
  /** Additional request headers. */
  headers?: Record<string, string>;
  /** Additional metadata. */
  metadata?: Record<string, string>;
  /** Progress callback (0-100). */
  onProgress?: (percent: number) => void;
}

/** Create Hono routes for multipart upload. */
export function createUploadRoutes(config: UploadConfig): Hono;

/** Compute SHA-256 hash of a File/Blob/ArrayBuffer using Web Crypto API. Returns lowercase hex string. */
export function hashFile(input: File | Blob | ArrayBuffer, onProgress?: (percent: number) => void): Promise<string>;

/** Client-side chunked file upload helper. */
export function uploadFile(params: UploadFileParams): Promise<Record<string, unknown>>;
