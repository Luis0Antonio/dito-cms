// Storage-provider abstraction. The media service talks to this interface instead of an R2
// binding directly, so a deployment can store media on Cloudflare R2 (default) or Cloudinary
// (when CLOUDINARY_URL is set) without the rest of the app changing. See ./index.ts for the
// auto-detecting factory, ./r2.ts and ./cloudinary.ts for the two implementations.

export type ProviderName = "r2" | "cloudinary";
export type StorageKind = "image" | "video";

/** Identity of the asset being stored — enough for either backend to derive its key. */
export interface PutInput {
  /** Stable media id (a nanoid); the R2 key / Cloudinary public_id is derived from it. */
  id: string;
  filename: string;
  mime: string;
  kind: StorageKind;
}

/** Result of a completed upload (single-shot or multipart). */
export interface PutResult {
  /** Generic storage-key slot. R2: object key `media/<id>/<file>`. Cloudinary: public_id. */
  storageKey: string;
  /** Cloudinary's absolute secure_url; undefined for R2 (served from our own origin). */
  url?: string;
  bytes: number;
  /** Cloudinary fills these from its upload response; R2 leaves them for the caller. */
  width?: number;
  height?: number;
  duration?: number;
}

export interface PutArgs {
  input: PutInput;
  body: ReadableStream;
  /** Content-Length when known (early size signal); may be null. */
  declaredTotal: number | null;
  /**
   * When set, Cloudinary ingests directly from this URL (server-side fetch) instead of
   * buffering `body` through the Worker — this is how large remote videos stay within the
   * Worker memory limit. R2 ignores it and streams `body`.
   */
  sourceUrl?: string;
}

/** Opaque handle for an in-flight multipart/chunked upload. */
export interface MultipartSession {
  /** R2: the R2 multipart uploadId. Cloudinary: the X-Unique-Upload-Id we generate. */
  uploadId: string;
  /** Generic storage-key slot, as in PutResult. */
  storageKey: string;
}

export interface PartRef {
  partNumber: number;
  /** R2: the real part etag. Cloudinary: synthetic (the part number) — never sent upstream. */
  etag: string;
}

export interface UploadPartArgs {
  session: MultipartSession;
  input: PutInput;
  partNumber: number;
  body: ReadableStream;
  contentLength: number | null;
  /** Byte offset of this part within the whole file (for Cloudinary's Content-Range). */
  offset: number;
  /** Declared total size of the whole file (for Cloudinary's Content-Range). */
  totalSize: number;
  /** True for the last part. Cloudinary returns the finished asset on the final chunk. */
  isFinal: boolean;
}

export interface CompleteArgs {
  session: MultipartSession;
  input: PutInput;
  parts: PartRef[];
  /**
   * Cloudinary finalizes implicitly on the last chunk; the media service captures that
   * result and passes it back here. R2 ignores it and assembles from `parts`.
   */
  finalFromLastPart?: PutResult;
}

export interface DeleteArgs {
  storageKey: string;
  kind: StorageKind;
}

export interface StorageProvider {
  readonly name: ProviderName;

  /** Single-shot upload (direct image, or a remote asset via `sourceUrl`). */
  put(args: PutArgs): Promise<PutResult>;

  /** Remove a stored object. Best-effort: a missing object is not an error. */
  delete(args: DeleteArgs): Promise<void>;

  // --- multipart / chunked (video) ---
  createMultipart(args: PutInput & { totalSize: number }): Promise<MultipartSession>;
  /** Upload one part. `final` is set only on the last Cloudinary chunk (the finished asset). */
  uploadPart(args: UploadPartArgs): Promise<{ part: PartRef; final?: PutResult }>;
  completeMultipart(args: CompleteArgs): Promise<PutResult>;
  abortMultipart(args: { session: MultipartSession }): Promise<void>;
}
