import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUploadRoutes } from '../src/index.js';

// ── Mock R2 Bucket ──────────────────────────

function createMockBucket() {
  const uploads = {};

  return {
    createMultipartUpload(key, opts) {
      const uploadId = `upload_${Date.now()}`;
      uploads[uploadId] = { key, opts, parts: [], completed: false, aborted: false };
      return { uploadId, key };
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        async uploadPart(partNumber, data) {
          const etag = `etag_${partNumber}`;
          if (uploads[uploadId]) uploads[uploadId].parts.push({ partNumber, etag });
          return { etag, partNumber };
        },
        async complete(parts) {
          if (uploads[uploadId]) uploads[uploadId].completed = true;
        },
        async abort() {
          if (uploads[uploadId]) uploads[uploadId].aborted = true;
        },
      };
    },
    _uploads: uploads,
  };
}

// ── Test Helper ─────────────────────────────

async function callRoute(app, method, path, body, query) {
  let url = `http://localhost${path}`;
  if (query) url += '?' + new URLSearchParams(query).toString();

  const opts = { method };
  if (body && typeof body === 'object' && !(body instanceof ArrayBuffer)) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }

  const req = new Request(url, opts);
  const res = await app.fetch(req, { BUCKET: createMockBucket() });
  const data = await res.json();
  return { status: res.status, data };
}

// ── Tests ───────────────────────────────────

describe('createUploadRoutes', () => {
  it('creates a Hono router', () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    assert.ok(routes);
    assert.ok(routes.fetch);
  });
});

describe('POST /create', () => {
  it('creates upload with fileName', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    const { status, data } = await callRoute(routes, 'POST', '/create', { fileName: 'test.zip' });
    assert.equal(status, 200);
    assert.ok(data.uploadId);
    assert.ok(data.key);
    assert.ok(data.key.includes('test.zip'));
  });

  it('uses custom keyPrefix', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET, keyPrefix: 'products/' });
    const { data } = await callRoute(routes, 'POST', '/create', { fileName: 'pack.zip' });
    assert.ok(data.key.startsWith('products/'));
  });

  it('rejects missing fileName', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    const { status, data } = await callRoute(routes, 'POST', '/create', {});
    assert.equal(status, 400);
    assert.ok(data.error.includes('fileName'));
  });
});

describe('PUT /part', () => {
  it('uploads a part', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    const { data: createData } = await callRoute(routes, 'POST', '/create', { fileName: 'test.zip' });

    const { status, data } = await callRoute(
      routes, 'PUT', '/part',
      new ArrayBuffer(1024),
      { key: createData.key, uploadId: createData.uploadId, partNumber: '1' }
    );
    assert.equal(status, 200);
    assert.ok(data.etag);
    assert.equal(data.partNumber, 1);
  });

  it('rejects missing params', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    const { status } = await callRoute(routes, 'PUT', '/part', new ArrayBuffer(10), {});
    assert.equal(status, 400);
  });
});

describe('POST /complete', () => {
  it('completes upload', async () => {
    let completeCalled = false;
    const routes = createUploadRoutes({
      bucket: (c) => c.env.BUCKET,
      onComplete: async ({ key, fileName }) => {
        completeCalled = true;
        return { fileId: 42 };
      },
    });

    const { data: createData } = await callRoute(routes, 'POST', '/create', { fileName: 'test.zip' });
    await callRoute(routes, 'PUT', '/part', new ArrayBuffer(1024),
      { key: createData.key, uploadId: createData.uploadId, partNumber: '1' });

    const { status, data } = await callRoute(routes, 'POST', '/complete', {
      key: createData.key,
      uploadId: createData.uploadId,
      parts: [{ partNumber: 1, etag: 'etag_1' }],
      fileName: 'test.zip',
      fileSize: 1024,
    });

    assert.equal(status, 200);
    assert.equal(data.completed, true);
    assert.equal(data.fileId, 42);
    assert.ok(completeCalled);
  });

  it('works without onComplete callback', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    const { data: createData } = await callRoute(routes, 'POST', '/create', { fileName: 'test.zip' });

    const { status, data } = await callRoute(routes, 'POST', '/complete', {
      key: createData.key,
      uploadId: createData.uploadId,
      parts: [{ partNumber: 1, etag: 'etag_1' }],
      fileName: 'test.zip',
    });

    assert.equal(status, 200);
    assert.equal(data.completed, true);
  });

  it('rejects missing parts', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    const { status } = await callRoute(routes, 'POST', '/complete', { key: 'k', uploadId: 'u' });
    assert.equal(status, 400);
  });
});

describe('POST /abort', () => {
  it('aborts upload', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    const { data: createData } = await callRoute(routes, 'POST', '/create', { fileName: 'test.zip' });

    const { status, data } = await callRoute(routes, 'POST', '/abort', {
      key: createData.key,
      uploadId: createData.uploadId,
    });

    assert.equal(status, 200);
    assert.equal(data.aborted, true);
  });

  it('rejects missing params', async () => {
    const routes = createUploadRoutes({ bucket: (c) => c.env.BUCKET });
    const { status } = await callRoute(routes, 'POST', '/abort', {});
    assert.equal(status, 400);
  });
});
