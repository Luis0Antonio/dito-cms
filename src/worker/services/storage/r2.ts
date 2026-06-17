// R2 implementation of StorageProvider. This is the default backend and preserves the
// original behavior exactly: object key `media/<id>/<filename>`, streamed puts, native R2
// multipart for video. URLs are served from our own origin (`url` stays undefined), so the
// media row's `url` column is null for R2 rows.

import type {
  CompleteArgs,
  DeleteArgs,
  MultipartSession,
  PartRef,
  ProviderName,
  PutArgs,
  PutInput,
  PutResult,
  StorageProvider,
  UploadPartArgs,
} from "./types";

/** The immutable R2 object key for a media id. Must match the public serve route. */
export function mediaKey(id: string, filename: string): string {
  return `media/${id}/${filename}`;
}

export class R2Provider implements StorageProvider {
  readonly name: ProviderName = "r2";

  constructor(private readonly bucket: R2Bucket) {}

  async put(args: PutArgs): Promise<PutResult> {
    const key = mediaKey(args.input.id, args.input.filename);
    const object = await this.bucket.put(key, args.body, {
      httpMetadata: { contentType: args.input.mime },
    });
    if (!object) throw new Error("R2 upload failed");
    return { storageKey: key, bytes: object.size };
  }

  async delete(args: DeleteArgs): Promise<void> {
    await this.bucket.delete(args.storageKey);
  }

  async createMultipart(args: PutInput & { totalSize: number }): Promise<MultipartSession> {
    const key = mediaKey(args.id, args.filename);
    const upload = await this.bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: args.mime },
    });
    return { uploadId: upload.uploadId, storageKey: key };
  }

  async uploadPart(args: UploadPartArgs): Promise<{ part: PartRef }> {
    const upload = this.bucket.resumeMultipartUpload(args.session.storageKey, args.session.uploadId);
    const uploaded = await upload.uploadPart(args.partNumber, args.body);
    return { part: { partNumber: uploaded.partNumber, etag: uploaded.etag } };
  }

  async completeMultipart(args: CompleteArgs): Promise<PutResult> {
    const upload = this.bucket.resumeMultipartUpload(args.session.storageKey, args.session.uploadId);
    const object = await upload.complete(args.parts);
    return { storageKey: args.session.storageKey, bytes: object.size };
  }

  async abortMultipart(args: { session: MultipartSession }): Promise<void> {
    await this.bucket.resumeMultipartUpload(args.session.storageKey, args.session.uploadId).abort();
  }
}
