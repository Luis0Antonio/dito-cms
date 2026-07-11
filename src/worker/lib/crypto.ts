// AES-256-GCM encryption for short secret strings (payment-provider keys, webhook auth
// headers) that must be stored in the D1 `settings` table but never sit there as plaintext.
// Keyed by the `SETTINGS_ENC_KEY` Wrangler secret — 32 raw bytes, standard-base64-encoded
// (generate with `openssl rand -base64 32`).
//
// The key is resolved and validated ONLY at encrypt/decrypt time, never at worker boot: a
// content-only or catalog-only instance that never configures payments must run without the
// secret set. Callers therefore only ever hit `requireKey` on the write/read path of a value
// that is actually being encrypted or decrypted.
//
// Wire format: `v1:` + base64( iv(12 bytes) ‖ ciphertext+tag ). WebCrypto appends the 16-byte
// GCM auth tag to the ciphertext itself, so the trailing bytes carry both. A fresh random IV
// is generated per encryption. The `v1:` prefix lets the format evolve (e.g. key rotation)
// without ambiguity on read.

/** Current wire-format version prefix. Bump if the scheme changes. */
const VERSION_PREFIX = "v1:";
/** GCM initialization vector length in bytes (96-bit IV is the AES-GCM standard). */
const IV_BYTES = 12;

/**
 * Raised when `SETTINGS_ENC_KEY` is needed but missing or malformed. The message is
 * operator-facing: it names the secret and how to set it. NOT an ApiError — this is a
 * misconfiguration, not a request-shaped failure, and it only ever surfaces when someone
 * tries to save or use an encrypted secret without the key in place.
 */
export class SettingsEncKeyError extends Error {
  constructor(reason: string) {
    super(
      `SETTINGS_ENC_KEY is ${reason}. It is required only when configuring payment providers ` +
        `or the order hook. Generate one with \`openssl rand -base64 32\`, then set it: ` +
        `\`wrangler secret put SETTINGS_ENC_KEY\` (deployed) or add it to \`.dev.vars\` (local).`,
    );
    this.name = "SettingsEncKeyError";
  }
}

/** Decode a standard-base64 string (as produced by `openssl rand -base64 32`) to bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode bytes as standard base64. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Import `SETTINGS_ENC_KEY` as an AES-GCM CryptoKey. Throws {@link SettingsEncKeyError} when
 * the secret is unset or does not decode to exactly 32 bytes (AES-256). Only called from the
 * encrypt/decrypt paths, so instances that never touch secrets never require the key.
 */
async function requireKey(env: Env): Promise<CryptoKey> {
  const raw = env.SETTINGS_ENC_KEY;
  if (!raw) throw new SettingsEncKeyError("not set");
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(raw.trim());
  } catch {
    throw new SettingsEncKeyError("not valid base64");
  }
  if (keyBytes.length !== 32) {
    throw new SettingsEncKeyError(`${keyBytes.length} bytes, expected 32 (base64 of 32 random bytes)`);
  }
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a short plaintext string. Returns the `v1:`-prefixed wire format documented above.
 * Requires `SETTINGS_ENC_KEY`; throws {@link SettingsEncKeyError} if it is missing/malformed.
 */
export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await requireKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.length);
  return VERSION_PREFIX + bytesToBase64(payload);
}

/**
 * Decrypt a value produced by {@link encryptSecret}. Requires `SETTINGS_ENC_KEY` (throws
 * {@link SettingsEncKeyError} if missing/malformed). Throws a plain Error on an unknown wire
 * version, and WebCrypto throws natively when the key is wrong or the ciphertext was tampered
 * with (GCM tag mismatch) — callers should treat any throw here as "cannot recover the secret".
 */
export async function decryptSecret(env: Env, ciphertext: string): Promise<string> {
  if (!ciphertext.startsWith(VERSION_PREFIX)) {
    throw new Error("Unrecognized encrypted-secret format (missing version prefix)");
  }
  const key = await requireKey(env);
  const payload = base64ToBytes(ciphertext.slice(VERSION_PREFIX.length));
  const iv = payload.subarray(0, IV_BYTES);
  const body = payload.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body);
  return new TextDecoder().decode(plaintext);
}
