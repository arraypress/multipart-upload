# @arraypress/multipart-upload

Chunked multipart upload for Hono + R2/S3. Server routes, client helper, and React hook — all in one package.

Bypasses Cloudflare Workers request body size limits. Includes SHA-256 hashing, duplicate detection, pause/resume, and auto-retry.

## Installation

```bash
npm install @arraypress/multipart-upload
```

Peer dependencies (both optional):
- `hono` — only needed for server routes
- `react` — only needed for the React hook

## Server Usage

```js
import { createUploadRoutes } from '@arraypress/multipart-upload';

const uploadRoutes = createUploadRoutes({
  bucket: (c) => c.env.BUCKET,         // R2 bucket binding
  keyPrefix: 'products/',               // object key prefix
  auth: adminAuth(),                    // optional Hono middleware
  onComplete: async ({ key, fileName, fileSize, mimeType, hashSha256, metadata, env }) => {
    const fileId = await createFile(env.DB, { fileKey: key, ... });
    return { fileId };  // included in response
  },
});

app.route('/api/upload', uploadRoutes);
```

Registers four routes:

| Route | Method | Purpose |
|---|---|---|
| `/create` | POST | Start a multipart upload |
| `/part` | PUT | Upload a single chunk |
| `/complete` | POST | Finalise the upload |
| `/abort` | POST | Cancel and clean up |

## React Hook

```jsx
import { useChunkedUpload } from '@arraypress/multipart-upload/react';

function MyUploader() {
  const upload = useChunkedUpload({
    uploadBase: '/api/upload',
    hashCheckUrl: '/api/files/check-hash',  // null to skip dedup
    metadata: { priceId: 42 },
    onComplete: (result) => console.log('Uploaded:', result),
    onError: (msg) => console.error(msg),
  });

  if (upload.state === 'idle') {
    return <input type="file" onChange={e => upload.selectFile(e.target.files[0])} />;
  }

  return (
    <div>
      <p>{upload.fileName} — {upload.progress}%</p>
      {upload.state === 'uploading' && <button onClick={upload.pause}>Pause</button>}
      {upload.state === 'paused' && <button onClick={upload.resume}>Resume</button>}
      {upload.state === 'duplicate' && (
        <>
          <p>Already exists: {upload.duplicateFile.original_name}</p>
          <button onClick={upload.uploadAnyway}>Upload Anyway</button>
          <button onClick={upload.reset}>Cancel</button>
        </>
      )}
    </div>
  );
}
```

### Hook Config

| Option | Type | Default | Description |
|---|---|---|---|
| `uploadBase` | `string` | required | Base URL of upload routes |
| `hashCheckUrl` | `string \| null` | `null` | URL for dedup hash check |
| `metadata` | `object` | `{}` | Extra metadata for the upload |
| `headers` | `object` | `{}` | Additional request headers |
| `chunkSize` | `number` | `10485760` | Chunk size in bytes (10MB) |
| `maxRetries` | `number` | `3` | Retry attempts per chunk |
| `autoDismissMs` | `number` | `2000` | Auto-reset after completion (0 to disable) |
| `onComplete` | `function` | — | Callback with server response |
| `onError` | `function` | — | Callback with error message |

### Hook Return

| Property | Type | Description |
|---|---|---|
| `state` | `UploadState` | `'idle'` `'hashing'` `'duplicate'` `'uploading'` `'paused'` `'complete'` `'error'` |
| `progress` | `number` | 0-100 percentage |
| `speed` | `number` | Bytes per second |
| `fileName` | `string` | Selected file name |
| `fileSize` | `number` | Selected file size |
| `errorMsg` | `string` | Error message (when state is 'error') |
| `duplicateFile` | `object \| null` | Existing file record (when state is 'duplicate') |
| `selectFile` | `(file: File) => void` | Start the upload flow |
| `pause` | `() => void` | Pause upload |
| `resume` | `() => void` | Resume upload |
| `cancel` | `() => void` | Cancel and abort |
| `reset` | `() => void` | Reset to idle |
| `uploadAnyway` | `() => void` | Skip dedup, upload anyway |
| `useDuplicate` | `() => object` | Accept duplicate, return file record |

## Client Helper (Vanilla JS)

```js
import { uploadFile } from '@arraypress/multipart-upload';

const result = await uploadFile({
  file: inputElement.files[0],
  baseUrl: '/api/upload',
  headers: { 'X-Admin-Key': apiKey },
  onProgress: (percent) => console.log(`${percent}%`),
});
```

## Hash Helper

```js
import { hashFile } from '@arraypress/multipart-upload';

const sha256 = await hashFile(file, (pct) => console.log(`Hashing: ${pct}%`));
// → 'a1b2c3d4...'
```

## License

MIT
