// Augments the wrangler-generated Env with secrets (not present in wrangler.jsonc
// vars). Set via `wrangler secret put BETTER_AUTH_SECRET` or the deploy-button
// prompt; when unset the worker falls back to a value stored in the settings table.
interface Env {
  BETTER_AUTH_SECRET?: string;
  /**
   * Cloudinary credentials in the standard `cloudinary://<api_key>:<api_secret>@<cloud_name>`
   * form. OPTIONAL — when set, media is stored on Cloudinary instead of R2 (no R2 bucket
   * needed); when unset, media uses the R2 bucket bound as `MEDIA`. See services/storage.
   * The `MEDIA` R2 binding is read through a cast accessor (see services/storage/index.ts)
   * so the worker compiles whether or not the bucket is bound.
   */
  CLOUDINARY_URL?: string;
}
