// Cloudinary implementation of StorageProvider. Active when CLOUDINARY_URL is set. Uses only
// `fetch` + Web Crypto, so it runs in a Worker with no Node APIs and no R2 bucket required.
//
// Uploads are signed (SHA-1 of the sorted params + api_secret). Images and remote-URL assets
// go through a single signed upload; large videos use Cloudinary's chunked upload (one
// X-Unique-Upload-Id per file + a Content-Range per part) so the existing browser→Worker part
// flow maps onto it unchanged. The finished asset is returned by Cloudinary on the final chunk.
//
// Docs: https://cloudinary.com/documentation/image_upload_api_reference
//       https://cloudinary.com/documentation/authentication_signatures

import type {
  CompleteArgs,
  DeleteArgs,
  MultipartSession,
  PartRef,
  ProviderName,
  PutArgs,
  PutInput,
  PutResult,
  StorageKind,
  StorageProvider,
  UploadPartArgs,
} from "./types";

export interface CloudinaryCreds {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** The subset of Cloudinary's upload/destroy JSON we read. */
interface CloudinaryResponse {
  public_id?: string;
  secure_url?: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration?: number;
  /** Present and false on intermediate chunks of a chunked upload. */
  done?: boolean;
  error?: { message?: string };
}

const API_BASE = "https://api.cloudinary.com/v1_1";

function resourceType(kind: StorageKind): "image" | "video" {
  return kind === "video" ? "video" : "image";
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class CloudinaryProvider implements StorageProvider {
  readonly name: ProviderName = "cloudinary";

  constructor(private readonly creds: CloudinaryCreds) {}

  /** Stable, collision-free public_id derived from the media id. */
  private publicId(id: string): string {
    return `dito/${id}`;
  }

  private endpoint(kind: StorageKind, action: "upload" | "destroy"): string {
    return `${API_BASE}/${this.creds.cloudName}/${resourceType(kind)}/${action}`;
  }

  /** SHA-1 of the params as sorted `k=v&…` with api_secret appended (Cloudinary's scheme). */
  private sign(params: Record<string, string>): Promise<string> {
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return sha1Hex(toSign + this.creds.apiSecret);
  }

  /** A FormData carrying `params` + a fresh timestamp, api_key, and the signature over both. */
  private async signedForm(params: Record<string, string>): Promise<FormData> {
    const signed = { ...params, timestamp: Math.floor(Date.now() / 1000).toString() };
    const signature = await this.sign(signed);
    const form = new FormData();
    for (const [k, v] of Object.entries(signed)) form.set(k, v);
    form.set("api_key", this.creds.apiKey);
    form.set("signature", signature);
    return form;
  }

  private async send(url: string, form: FormData, headers?: Record<string, string>): Promise<CloudinaryResponse> {
    const res = await fetch(url, { method: "POST", body: form, headers });
    let json: CloudinaryResponse;
    try {
      json = (await res.json()) as CloudinaryResponse;
    } catch {
      throw new Error(`Cloudinary returned a non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok || json.error) {
      throw new Error(`Cloudinary request failed: ${json.error?.message ?? `HTTP ${res.status}`}`);
    }
    return json;
  }

  private toResult(json: CloudinaryResponse): PutResult {
    if (!json.public_id || !json.secure_url || json.bytes == null) {
      throw new Error("Cloudinary response was missing the stored asset details");
    }
    return {
      storageKey: json.public_id,
      url: json.secure_url,
      bytes: json.bytes,
      width: json.width,
      height: json.height,
      duration: json.duration,
    };
  }

  async put(args: PutArgs): Promise<PutResult> {
    const form = await this.signedForm({ public_id: this.publicId(args.input.id) });
    if (args.sourceUrl) {
      // Hand the URL to Cloudinary so it fetches server-side — no buffering through the Worker,
      // which keeps large remote videos (MCP url-upload) within the memory limit.
      form.set("file", args.sourceUrl);
    } else {
      const buf = await new Response(args.body).arrayBuffer();
      form.set("file", new Blob([buf], { type: args.input.mime }), args.input.filename);
    }
    return this.toResult(await this.send(this.endpoint(args.input.kind, "upload"), form));
  }

  async delete(args: DeleteArgs): Promise<void> {
    const form = await this.signedForm({ public_id: args.storageKey });
    // Best-effort: a not-yet-finalized or already-removed asset returns "not found" — ignore it.
    try {
      await this.send(this.endpoint(args.kind, "destroy"), form);
    } catch {
      /* deletion is best-effort; the DB row is removed regardless */
    }
  }

  createMultipart(args: PutInput & { totalSize: number }): Promise<MultipartSession> {
    // No network call: Cloudinary assembles chunks implicitly, keyed by X-Unique-Upload-Id.
    return Promise.resolve({ uploadId: crypto.randomUUID(), storageKey: this.publicId(args.id) });
  }

  async uploadPart(args: UploadPartArgs): Promise<{ part: PartRef; final?: PutResult }> {
    const form = await this.signedForm({ public_id: args.session.storageKey });
    const buf = await new Response(args.body).arrayBuffer();
    form.set("file", new Blob([buf], { type: args.input.mime }), args.input.filename);
    const end = args.offset + buf.byteLength - 1;
    const json = await this.send(this.endpoint(args.input.kind, "upload"), form, {
      "X-Unique-Upload-Id": args.session.uploadId,
      "Content-Range": `bytes ${args.offset}-${end}/${args.totalSize}`,
    });
    // Synthetic etag (the part number) keeps the client's {partNumber, etag} contract intact.
    const part: PartRef = { partNumber: args.partNumber, etag: String(args.partNumber) };
    if (!args.isFinal) return { part };
    return { part, final: this.toResult(json) };
  }

  completeMultipart(args: CompleteArgs): Promise<PutResult> {
    // Cloudinary finalized on the last chunk; the media service captured that asset and hands
    // it back here. There is nothing to assemble.
    if (!args.finalFromLastPart) {
      throw new Error("Cloudinary upload was not finalized (the final chunk did not return an asset)");
    }
    return Promise.resolve(args.finalFromLastPart);
  }

  abortMultipart(): Promise<void> {
    // Cloudinary has no multipart-abort: an unfinished chunked upload simply expires. Any
    // finalized asset is cleaned up by delete() when the media row is removed.
    return Promise.resolve();
  }
}
