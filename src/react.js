/**
 * @arraypress/multipart-upload/react
 *
 * React hook for chunked multipart file uploads with SHA-256 dedup,
 * progress tracking, pause/resume/cancel, and retry logic.
 *
 * Pairs with createUploadRoutes() on the server side.
 *
 * @module @arraypress/multipart-upload/react
 */

import { useState, useRef, useCallback } from 'react';
import { hashFile } from './index.js';

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_RETRIES = 3;

/**
 * React hook for chunked file uploads.
 *
 * Handles the full upload lifecycle: SHA-256 hashing → duplicate check →
 * chunked multipart upload with pause/resume/cancel → completion.
 *
 * Designed to work with the server routes created by `createUploadRoutes()`.
 *
 * @param {Object} config - Upload configuration.
 * @param {string} config.uploadBase - Base URL of upload routes (e.g. '/api/upload').
 * @param {string|null} [config.hashCheckUrl] - URL to check for duplicate files. Null to skip dedup.
 * @param {Object} [config.metadata] - Extra metadata passed through to the upload.
 * @param {Object} [config.headers] - Additional request headers (e.g. auth tokens).
 * @param {number} [config.chunkSize] - Override chunk size in bytes (default 10MB).
 * @param {number} [config.maxRetries] - Override max retry attempts per chunk (default 3).
 * @param {number} [config.autoDismissMs] - Auto-reset delay after completion in ms (default 2000, 0 to disable).
 * @param {Function} [config.onComplete] - Called with the server response after successful upload.
 * @param {Function} [config.onError] - Called with error message string on failure.
 * @returns {UseChunkedUploadReturn}
 *
 * @example
 * import { useChunkedUpload } from '@arraypress/multipart-upload/react';
 *
 * function MyUploader() {
 *   const upload = useChunkedUpload({
 *     uploadBase: '/api/upload',
 *     hashCheckUrl: '/api/files/check-hash',
 *     onComplete: (result) => console.log('Uploaded:', result),
 *   });
 *
 *   return (
 *     <div>
 *       <input type="file" onChange={(e) => {
 *         if (e.target.files[0]) upload.selectFile(e.target.files[0]);
 *       }} />
 *       <p>State: {upload.state}</p>
 *       <p>Progress: {upload.progress}%</p>
 *       {upload.state === 'uploading' && <button onClick={upload.pause}>Pause</button>}
 *       {upload.state === 'paused' && <button onClick={upload.resume}>Resume</button>}
 *       {upload.state === 'duplicate' && (
 *         <>
 *           <p>File already exists: {upload.duplicateFile.original_name}</p>
 *           <button onClick={upload.uploadAnyway}>Upload Anyway</button>
 *           <button onClick={upload.reset}>Cancel</button>
 *         </>
 *       )}
 *     </div>
 *   );
 * }
 */
export function useChunkedUpload(config) {
  const {
    uploadBase,
    hashCheckUrl = null,
    metadata = {},
    headers: extraHeaders = {},
    chunkSize = CHUNK_SIZE,
    maxRetries = MAX_RETRIES,
    autoDismissMs = 2000,
    onComplete,
    onError,
  } = config;

  const [state, setState] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [duplicateFile, setDuplicateFile] = useState(null);

  const pendingFileRef = useRef(null);
  const pendingHashRef = useRef('');
  const abortRef = useRef(false);
  const pauseRef = useRef(false);

  const reset = useCallback(() => {
    setState('idle');
    setProgress(0);
    setFileName('');
    setFileSize(0);
    setSpeed(0);
    setErrorMsg('');
    setDuplicateFile(null);
    pendingFileRef.current = null;
    pendingHashRef.current = '';
    abortRef.current = false;
    pauseRef.current = false;
  }, []);

  const checkDuplicate = async (hash) => {
    if (!hashCheckUrl) return null;
    try {
      const res = await fetch(`${hashCheckUrl}?hash=${encodeURIComponent(hash)}`, {
        headers: extraHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        return data.file || null;
      }
    } catch {}
    return null;
  };

  const uploadPart = async (file, key, uploadId, partNumber) => {
    const start = (partNumber - 1) * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(
          `${uploadBase}/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
          { method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream', ...extraHeaders } }
        );
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || `Part ${partNumber} failed (${response.status})`);
        }
        return await response.json();
      } catch (err) {
        if (attempt === maxRetries) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  };

  const startUpload = useCallback(async (file, hash) => {
    setState('uploading');
    setProgress(0);
    setSpeed(0);
    abortRef.current = false;
    pauseRef.current = false;

    const totalParts = Math.ceil(file.size / chunkSize);
    const jsonHeaders = { 'Content-Type': 'application/json', ...extraHeaders };

    try {
      const createRes = await fetch(`${uploadBase}/create`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || 'application/octet-stream',
          metadata: metadata || {},
        }),
      });
      if (!createRes.ok) throw new Error('Failed to create upload');
      const { uploadId, key } = await createRes.json();

      const parts = [];
      const startTime = Date.now();

      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (abortRef.current) {
          await fetch(`${uploadBase}/abort`, {
            method: 'POST', headers: jsonHeaders,
            body: JSON.stringify({ key, uploadId }),
          }).catch(() => {});
          reset();
          return;
        }

        while (pauseRef.current) {
          if (abortRef.current) {
            await fetch(`${uploadBase}/abort`, {
              method: 'POST', headers: jsonHeaders,
              body: JSON.stringify({ key, uploadId }),
            }).catch(() => {});
            reset();
            return;
          }
          await new Promise(r => setTimeout(r, 200));
        }

        const result = await uploadPart(file, key, uploadId, partNumber);
        parts.push({ partNumber: result.partNumber, etag: result.etag });

        const uploaded = Math.min(partNumber * chunkSize, file.size);
        setProgress(Math.round((uploaded / file.size) * 100));
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed > 0) setSpeed(Math.round(uploaded / elapsed));
      }

      const completeRes = await fetch(`${uploadBase}/complete`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          key, uploadId, parts,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || 'application/octet-stream',
          hashSha256: hash || '',
          metadata: metadata || {},
        }),
      });
      if (!completeRes.ok) throw new Error('Failed to complete upload');
      const uploadResult = await completeRes.json();

      setState('complete');
      setProgress(100);
      onComplete?.(uploadResult);

      if (autoDismissMs > 0) {
        setTimeout(() => reset(), autoDismissMs);
      }
    } catch (err) {
      setState('error');
      setErrorMsg(err.message);
      onError?.(err.message);
    }
  }, [uploadBase, metadata, extraHeaders, chunkSize, maxRetries, autoDismissMs, onComplete, onError, reset]);

  const selectFile = useCallback(async (file) => {
    setFileName(file.name);
    setFileSize(file.size);
    setState('hashing');
    setProgress(0);

    try {
      const hash = await hashFile(file, (pct) => setProgress(pct));
      const existing = await checkDuplicate(hash);
      if (existing) {
        setDuplicateFile(existing);
        pendingFileRef.current = file;
        pendingHashRef.current = hash;
        setState('duplicate');
        return;
      }
      await startUpload(file, hash);
    } catch (err) {
      console.warn('SHA-256 failed, uploading without dedup:', err);
      await startUpload(file, '');
    }
  }, [startUpload, hashCheckUrl]);

  const pause = useCallback(() => { pauseRef.current = true; setState('paused'); }, []);
  const resume = useCallback(() => { pauseRef.current = false; setState('uploading'); }, []);
  const cancel = useCallback(() => { abortRef.current = true; pauseRef.current = false; }, []);

  const uploadAnyway = useCallback(() => {
    const file = pendingFileRef.current;
    const hash = pendingHashRef.current;
    if (file) {
      setDuplicateFile(null);
      startUpload(file, hash);
    }
  }, [startUpload]);

  const useDuplicate = useCallback(() => {
    const file = duplicateFile;
    reset();
    return file;
  }, [duplicateFile, reset]);

  return {
    state, progress, speed, fileName, fileSize, errorMsg, duplicateFile,
    selectFile, pause, resume, cancel, reset, uploadAnyway, useDuplicate,
  };
}
