/**
 * @arraypress/multipart-upload
 *
 * Chunked multipart upload routes for Hono + R2/S3.
 * Bypasses the Workers request body size limit by splitting files
 * into parts and uploading each individually.
 *
 * Flow:
 *   1. POST /create    → creates multipart upload, returns uploadId + key
 *   2. PUT  /part      → uploads a single chunk, returns ETag
 *   3. POST /complete  → finalises the upload, calls onComplete callback
 *   4. POST /abort     → cancels an in-progress upload
 *
 * @module @arraypress/multipart-upload
 */

import { Hono } from 'hono';

/**
 * @typedef {Object} UploadConfig
 * @property {Object} bucket - R2 bucket binding (env.BUCKET).
 * @property {string} [keyPrefix='uploads/'] - Prefix for object keys.
 * @property {Function} [auth] - Optional Hono middleware for auth.
 * @property {Function} [onComplete] - Callback after upload completes.
 *   Receives { key, fileName, fileSize, mimeType, hashSha256, metadata }.
 *   Return value is included in the response.
 */

/**
 * Create Hono routes for multipart upload.
 *
 * @param {UploadConfig} config
 * @returns {Hono} Hono router with upload routes.
 *
 * @example
 * import { createUploadRoutes } from '@arraypress/multipart-upload';
 * import { adminAuth } from './lib/admin-auth.js';
 *
 * const uploadRoutes = createUploadRoutes({
 *   bucket: (c) => c.env.BUCKET,
 *   keyPrefix: 'products/',
 *   auth: adminAuth(),
 *   onComplete: async ({ key, fileName, fileSize, mimeType }) => {
 *     const fileId = await createFile(db, { fileKey: key, originalName: fileName, fileSize, mimeType });
 *     return { fileId };
 *   },
 * });
 *
 * app.route('/api/upload', uploadRoutes);
 */
export function createUploadRoutes(config) {
  const {
    bucket: getBucket,
    keyPrefix = 'uploads/',
    auth,
    onComplete,
  } = config;

  const router = new Hono();

  // Apply auth middleware if provided
  if (auth) {
    router.use('/*', auth);
  }

  // Resolve bucket — supports both a binding object and a function
  function resolveBucket(c) {
    return typeof getBucket === 'function' ? getBucket(c) : getBucket;
  }

  /**
   * POST /create
   * Body: { fileName, fileSize?, mimeType?, metadata? }
   * Returns: { uploadId, key }
   */
  router.post('/create', async (c) => {
    const { fileName, fileSize, mimeType, metadata } = await c.req.json();

    if (!fileName) {
      return c.json({ error: 'fileName is required' }, 400);
    }

    const bucket = resolveBucket(c);
    const key = `${keyPrefix}${Date.now()}-${fileName}`;

    const multipartUpload = await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: mimeType || 'application/octet-stream' },
      customMetadata: { originalName: fileName, ...(metadata || {}) },
    });

    return c.json({
      uploadId: multipartUpload.uploadId,
      key,
    });
  });

  /**
   * PUT /part
   * Query: ?key=...&uploadId=...&partNumber=1
   * Body: raw binary chunk
   * Returns: { etag, partNumber }
   */
  router.put('/part', async (c) => {
    const key = c.req.query('key');
    const uploadId = c.req.query('uploadId');
    const partNumber = parseInt(c.req.query('partNumber'), 10);

    if (!key || !uploadId || !partNumber) {
      return c.json({ error: 'key, uploadId, and partNumber are required' }, 400);
    }

    const bucket = resolveBucket(c);
    const multipartUpload = bucket.resumeMultipartUpload(key, uploadId);
    const blob = await c.req.arrayBuffer();
    const part = await multipartUpload.uploadPart(partNumber, blob);

    return c.json({
      etag: part.etag,
      partNumber: part.partNumber,
    });
  });

  /**
   * POST /complete
   * Body: { key, uploadId, parts, fileName, fileSize?, mimeType?, hashSha256?, metadata? }
   * Returns: { completed: true, ...onComplete result }
   */
  router.post('/complete', async (c) => {
    const { key, uploadId, parts, fileName, fileSize, mimeType, hashSha256, metadata } = await c.req.json();

    if (!key || !uploadId || !parts?.length) {
      return c.json({ error: 'key, uploadId, and parts are required' }, 400);
    }

    const bucket = resolveBucket(c);
    const multipartUpload = bucket.resumeMultipartUpload(key, uploadId);
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await multipartUpload.complete(sortedParts);

    let extra = {};
    if (onComplete) {
      const result = await onComplete({
        key,
        fileName,
        fileSize: fileSize || 0,
        mimeType: mimeType || 'application/octet-stream',
        hashSha256: hashSha256 || '',
        metadata: metadata || {},
        env: c.env,
      });
      if (result && typeof result === 'object') extra = result;
    }

    return c.json({ completed: true, key, fileName, ...extra });
  });

  /**
   * POST /abort
   * Body: { key, uploadId }
   * Returns: { aborted: true }
   */
  router.post('/abort', async (c) => {
    const { key, uploadId } = await c.req.json();

    if (!key || !uploadId) {
      return c.json({ error: 'key and uploadId are required' }, 400);
    }

    try {
      const bucket = resolveBucket(c);
      const multipartUpload = bucket.resumeMultipartUpload(key, uploadId);
      await multipartUpload.abort();
    } catch (e) {
      console.warn('Abort warning:', e.message);
    }

    return c.json({ aborted: true });
  });

  return router;
}

/**
 * Compute the SHA-256 hash of a File using the Web Crypto API.
 *
 * Returns a lowercase hex string. Reads the entire file into memory,
 * so for very large files (500MB+) this may be slow.
 *
 * Works in browsers, Cloudflare Workers, Node.js 18+, Deno, and Bun.
 *
 * @param {File|Blob|ArrayBuffer} input - The file, blob, or buffer to hash.
 * @param {Function} [onProgress] - Optional progress callback (0-100). Called at 50% (read) and 100% (hashed).
 * @returns {Promise<string>} Lowercase hex SHA-256 hash.
 *
 * @example
 * const hash = await hashFile(fileInput.files[0]);
 * // → 'a1b2c3d4e5f6...'
 *
 * @example
 * // With progress
 * const hash = await hashFile(file, (pct) => console.log(`${pct}%`));
 */
export async function hashFile(input, onProgress) {
  const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  if (onProgress) onProgress(50);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  if (onProgress) onProgress(100);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Client-side chunk upload helper.
 *
 * Splits a File into chunks and uploads via the multipart API.
 * Designed for browser use — takes a File object and a base URL.
 *
 * @param {Object} params
 * @param {File} params.file - The file to upload.
 * @param {string} params.baseUrl - Base URL of the upload routes (e.g. '/api/upload').
 * @param {number} [params.chunkSize=5242880] - Chunk size in bytes (default 5MB).
 * @param {Object} [params.headers] - Additional headers (e.g. auth).
 * @param {Object} [params.metadata] - Additional metadata to pass to onComplete.
 * @param {Function} [params.onProgress] - Progress callback (0-100).
 * @returns {Promise<Object>} The complete response from the server.
 *
 * @example
 * const result = await uploadFile({
 *   file: inputElement.files[0],
 *   baseUrl: '/admin/api/upload',
 *   headers: { 'X-Admin-Key': apiKey },
 *   onProgress: (pct) => setProgress(pct),
 * });
 */
export async function uploadFile(params) {
  const {
    file,
    baseUrl,
    chunkSize = 5 * 1024 * 1024, // 5MB
    headers = {},
    metadata = {},
    onProgress,
  } = params;

  const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

  // 1. Create multipart upload
  const createRes = await fetch(`${baseUrl}/create`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      metadata,
    }),
  });

  if (!createRes.ok) throw new Error('Failed to create upload');
  const { uploadId, key } = await createRes.json();

  // 2. Upload chunks
  const totalParts = Math.ceil(file.size / chunkSize);
  const parts = [];

  try {
    for (let i = 0; i < totalParts; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);

      const partRes = await fetch(
        `${baseUrl}/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${i + 1}`,
        { method: 'PUT', headers, body: chunk }
      );

      if (!partRes.ok) throw new Error(`Failed to upload part ${i + 1}`);
      const part = await partRes.json();
      parts.push(part);

      if (onProgress) {
        onProgress(Math.round(((i + 1) / totalParts) * 100));
      }
    }

    // 3. Complete
    const completeRes = await fetch(`${baseUrl}/complete`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        key,
        uploadId,
        parts,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        metadata,
      }),
    });

    if (!completeRes.ok) throw new Error('Failed to complete upload');
    return completeRes.json();
  } catch (err) {
    // Abort on failure
    await fetch(`${baseUrl}/abort`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ key, uploadId }),
    }).catch(() => {});
    throw err;
  }
}
