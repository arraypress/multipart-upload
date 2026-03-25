# @arraypress/multipart-upload

Chunked multipart upload routes for Hono + R2/S3. Bypasses the Cloudflare Workers request body size limit by splitting files into parts.

Includes both server-side Hono routes and a client-side upload helper with progress tracking.

## Installation

```bash
npm install @arraypress/multipart-upload
```

Requires `hono` as a peer dependency.

## Server Usage

```js
import { createUploadRoutes } from '@arraypress/multipart-upload';

const uploadRoutes = createUploadRoutes({
  bucket: (c) => c.env.BUCKET,         // R2 bucket binding
  keyPrefix: 'products/',               // object key prefix
  auth: adminAuth(),                    // optional Hono middleware
  onComplete: async ({ key, fileName, fileSize, mimeType, env }) => {
    // Create DB record, assign to product, etc.
    const fileId = await createFile(env.DB, { fileKey: key, originalName: fileName, fileSize, mimeType });
    return { fileId };  // included in response
  },
});

app.route('/api/upload', uploadRoutes);
```

This registers four routes:

| Route | Method | Purpose |
|---|---|---|
| `/create` | POST | Start a multipart upload |
| `/part` | PUT | Upload a single chunk |
| `/complete` | POST | Finalise the upload |
| `/abort` | POST | Cancel and clean up |

## Client Usage

```js
import { uploadFile } from '@arraypress/multipart-upload';

const result = await uploadFile({
  file: inputElement.files[0],
  baseUrl: '/api/upload',
  headers: { 'X-Admin-Key': apiKey },
  chunkSize: 5 * 1024 * 1024,  // 5MB (default)
  onProgress: (percent) => {
    progressBar.style.width = `${percent}%`;
  },
});

console.log(result.fileId);  // from onComplete
```

The client helper:
- Splits the File into chunks
- Uploads each chunk sequentially
- Reports progress (0-100%)
- Automatically aborts on failure
- Returns the complete response including `onComplete` results

## API

### `createUploadRoutes(config)`

Create Hono routes for multipart uploads.

Config:
- `bucket` — R2 bucket binding or function `(c) => c.env.BUCKET`
- `keyPrefix` — Object key prefix (default `'uploads/'`)
- `auth` — Optional Hono middleware for authentication
- `onComplete` — Async callback after upload completes. Receives `{ key, fileName, fileSize, mimeType, hashSha256, metadata, env }`. Return value is merged into the response.

### `uploadFile(params)`

Client-side chunked upload helper.

Params:
- `file` — File object to upload
- `baseUrl` — Base URL of the upload routes
- `chunkSize` — Chunk size in bytes (default 5MB)
- `headers` — Additional request headers (auth, etc.)
- `metadata` — Additional metadata passed to onComplete
- `onProgress` — Progress callback receiving percentage (0-100)

## License

MIT
