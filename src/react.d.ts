/**
 * Upload state machine states.
 *
 * - `idle` — Ready for file selection
 * - `hashing` — Computing SHA-256 hash
 * - `duplicate` — Duplicate detected, awaiting user decision
 * - `uploading` — Chunked upload in progress
 * - `paused` — Upload paused by user
 * - `complete` — Upload finished successfully
 * - `error` — Upload failed
 */
export type UploadState = 'idle' | 'hashing' | 'duplicate' | 'uploading' | 'paused' | 'complete' | 'error';

/** Configuration for the useChunkedUpload hook. */
export interface UseChunkedUploadConfig {
  /** Base URL of the upload routes (e.g. '/api/upload'). Must serve /create, /part, /complete, /abort. */
  uploadBase: string;

  /** URL to check for duplicate files by hash (e.g. '/api/files/check-hash'). Null to skip dedup. */
  hashCheckUrl?: string | null;

  /** Extra metadata passed through to the upload's create and complete requests. */
  metadata?: Record<string, unknown>;

  /** Additional request headers (e.g. auth tokens). Applied to all fetch calls. */
  headers?: Record<string, string>;

  /** Chunk size in bytes. Default: 10MB (10485760). */
  chunkSize?: number;

  /** Max retry attempts per chunk on failure. Default: 3. */
  maxRetries?: number;

  /** Auto-reset delay after completion in ms. Default: 2000. Set to 0 to disable. */
  autoDismissMs?: number;

  /** Called with the server response after successful upload. */
  onComplete?: (result: Record<string, unknown>) => void;

  /** Called with error message string on failure. */
  onError?: (message: string) => void;
}

/** A file record returned by the dedup check endpoint. */
export interface DuplicateFile {
  id: number | string;
  file_key: string;
  original_name: string;
  display_name?: string;
  file_size: number;
  [key: string]: unknown;
}

/** Return value of the useChunkedUpload hook. */
export interface UseChunkedUploadReturn {
  /** Current upload state. */
  state: UploadState;

  /** Upload progress percentage (0-100). During hashing, reflects hash progress. */
  progress: number;

  /** Upload speed in bytes per second. Zero when not actively uploading. */
  speed: number;

  /** Name of the currently selected file. Empty when idle. */
  fileName: string;

  /** Size of the currently selected file in bytes. Zero when idle. */
  fileSize: number;

  /** Error message when state is 'error'. Empty otherwise. */
  errorMsg: string;

  /** The existing file record when state is 'duplicate'. Null otherwise. */
  duplicateFile: DuplicateFile | null;

  /** Start the upload flow for a file. Hashes, checks dedup, then uploads. */
  selectFile: (file: File) => Promise<void>;

  /** Pause the current upload. Only works when state is 'uploading'. */
  pause: () => void;

  /** Resume a paused upload. Only works when state is 'paused'. */
  resume: () => void;

  /** Cancel the current upload and abort the multipart upload on the server. */
  cancel: () => void;

  /** Reset to idle state. Clears all state and cancels any pending operations. */
  reset: () => void;

  /** Skip dedup and upload the pending file anyway. Only works when state is 'duplicate'. */
  uploadAnyway: () => void;

  /** Accept the duplicate and return the existing file record. Resets to idle. */
  useDuplicate: () => DuplicateFile | null;
}

/**
 * React hook for chunked file uploads with SHA-256 dedup,
 * progress tracking, pause/resume/cancel, and retry logic.
 *
 * Pairs with `createUploadRoutes()` on the server side.
 *
 * @example
 * ```tsx
 * import { useChunkedUpload } from '@arraypress/multipart-upload/react';
 *
 * function MyUploader() {
 *   const upload = useChunkedUpload({
 *     uploadBase: '/api/upload',
 *     hashCheckUrl: '/api/files/check-hash',
 *     onComplete: (result) => console.log('Uploaded:', result),
 *   });
 *
 *   if (upload.state === 'idle') {
 *     return <input type="file" onChange={e => upload.selectFile(e.target.files![0])} />;
 *   }
 *
 *   return <p>{upload.state}: {upload.progress}%</p>;
 * }
 * ```
 */
export function useChunkedUpload(config: UseChunkedUploadConfig): UseChunkedUploadReturn;
