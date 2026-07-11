import type { DrizzleDb } from "../../db/client";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { validationError } from "../../lib/errors";
import { getSetting, setSetting } from "../settings";
import { validateHookUrl } from "../deploy-hook";

import type {
  CulqiSettings,
  OrderHookSettings,
  StoreSettings,
  UpdateCulqiInput,
  UpdateOrderHookInput,
} from "@/shared/api-types";

// Store-module settings: currency, the Culqi payment gateway config, and the order-notification
// hook config. All persist through the generic getSetting/setSetting machinery (like the
// commerce toggle and deploy hook), each under one JSON-encoded key.
//
// Two secrets live here and are ENCRYPTED at rest via lib/crypto.ts (AES-256-GCM, keyed by the
// SETTINGS_ENC_KEY Wrangler secret): the Culqi secret key and the order-hook auth header value.
// Everything secret is write-only from the admin — redacted reads report only whether a value
// is configured, never the value itself (the deploy-hook redaction approach).
//
// The accessors are split by whether they touch the encryption key:
//   - Key-free:  getStoreCurrency, getRedactedCulqi, getRedactedOrderHook, getStoreSettings.
//     A store that never configures payments — and so never sets SETTINGS_ENC_KEY — must still
//     open its settings, so redacted views NEVER decrypt; they only test for presence.
//   - Key at use-time:  setCulqiConfig / getCulqiConfig and setOrderHookConfig / getOrderHookConfig,
//     which encrypt on write and decrypt on read. These are the only paths that require the key.
//
// Callers gate on `commerce_enabled` at the route/MCP layer; these accessors do not re-gate.

const CURRENCY_KEY = "store_currency";
const CULQI_KEY = "store_culqi";
const ORDER_HOOK_KEY = "store_order_hook";

/** Default ISO 4217 currency for new orders when none is configured (standard for Peru / Culqi). */
const DEFAULT_CURRENCY = "PEN";

const PUBLIC_KEY_RE = /^pk_(test|live)_/;
const SECRET_KEY_RE = /^sk_(test|live)_/;

// --- Currency ---------------------------------------------------------------

/** The configured store currency, or the {@link DEFAULT_CURRENCY} default when unset. */
export async function getStoreCurrency(db: DrizzleDb): Promise<string> {
  return (await getSetting(db, CURRENCY_KEY)) || DEFAULT_CURRENCY;
}

/** Persist the store currency. Must be a 3-letter ISO 4217 code (e.g. `PEN`, `USD`). */
export async function setStoreCurrency(db: DrizzleDb, currency: string): Promise<string> {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw validationError("Currency must be a 3-letter ISO 4217 code", {
      currency: "Enter a 3-letter code, e.g. PEN",
    });
  }
  await setSetting(db, CURRENCY_KEY, code);
  return code;
}

// --- Culqi gateway ----------------------------------------------------------

/** The Culqi config as stored: the secret key is held encrypted (`secretKeyEnc`). */
interface CulqiConfig {
  enabled: boolean;
  publicKey: string;
  /** AES-GCM ciphertext of the secret key (lib/crypto wire format); empty when unset. */
  secretKeyEnc: string;
}

const EMPTY_CULQI: CulqiConfig = { enabled: false, publicKey: "", secretKeyEnc: "" };

function parseCulqi(raw: string | undefined): CulqiConfig {
  if (!raw) return { ...EMPTY_CULQI };
  try {
    const parsed = JSON.parse(raw) as Partial<CulqiConfig>;
    return {
      enabled: parsed.enabled === true,
      publicKey: typeof parsed.publicKey === "string" ? parsed.publicKey : "",
      secretKeyEnc: typeof parsed.secretKeyEnc === "string" ? parsed.secretKeyEnc : "",
    };
  } catch {
    return { ...EMPTY_CULQI };
  }
}

async function readCulqi(db: DrizzleDb): Promise<CulqiConfig> {
  return parseCulqi(await getSetting(db, CULQI_KEY));
}

/**
 * Merge a PATCH into the stored Culqi config and persist it. PATCH semantics (like the deploy
 * hook): an omitted field is left unchanged, so `enabled` can toggle without resending the
 * secret key. A non-empty `secretKey` is validated then ENCRYPTED (requires SETTINGS_ENC_KEY);
 * an explicit empty-string `secretKey` clears the stored secret. Enabling the gateway requires
 * both a public key and a stored secret, so a half-configured gateway can never go live.
 */
export async function setCulqiConfig(
  db: DrizzleDb,
  env: Env,
  patch: UpdateCulqiInput,
): Promise<CulqiSettings> {
  const next = await readCulqi(db);

  if (patch.publicKey !== undefined) {
    const pk = patch.publicKey.trim();
    if (pk !== "" && !PUBLIC_KEY_RE.test(pk)) {
      throw validationError("Invalid Culqi public key", {
        publicKey: "Must start with pk_test_ or pk_live_",
      });
    }
    next.publicKey = pk;
  }

  if (patch.secretKey !== undefined) {
    const sk = patch.secretKey.trim();
    if (sk === "") {
      next.secretKeyEnc = "";
    } else {
      if (!SECRET_KEY_RE.test(sk)) {
        throw validationError("Invalid Culqi secret key", {
          secretKey: "Must start with sk_test_ or sk_live_",
        });
      }
      // Encrypt only after validation — this is the sole key-touching step of the write.
      next.secretKeyEnc = await encryptSecret(env, sk);
    }
  }

  if (patch.enabled !== undefined) next.enabled = patch.enabled;

  if (next.enabled && (!next.publicKey || !next.secretKeyEnc)) {
    throw validationError("Add a Culqi public key and secret key before enabling the gateway", {
      enabled: "Configure both keys first",
    });
  }

  await setSetting(db, CULQI_KEY, JSON.stringify(next));
  return toRedactedCulqi(next);
}

function toRedactedCulqi(config: CulqiConfig): CulqiSettings {
  return {
    enabled: config.enabled,
    publicKey: config.publicKey,
    secretKeyConfigured: config.secretKeyEnc !== "",
  };
}

/** Redacted Culqi view for admin reads. Key-free: the secret key is reported only as configured/not. */
export async function getRedactedCulqi(db: DrizzleDb): Promise<CulqiSettings> {
  return toRedactedCulqi(await readCulqi(db));
}

/** The decrypted Culqi config for the payment driver (phase 2C). Null when Culqi is not configured. */
export interface CulqiRuntimeConfig {
  enabled: boolean;
  publicKey: string;
  /** The plaintext Culqi secret key, decrypted at use-time. */
  secretKey: string;
}

/**
 * Resolve the Culqi config with its secret key DECRYPTED, for internal driver use. Returns null
 * when no secret key is stored. Requires SETTINGS_ENC_KEY (decryption throws if missing/malformed
 * or if the stored ciphertext cannot be authenticated). This is a key-touching accessor.
 */
export async function getCulqiConfig(db: DrizzleDb, env: Env): Promise<CulqiRuntimeConfig | null> {
  const config = await readCulqi(db);
  if (!config.secretKeyEnc) return null;
  const secretKey = await decryptSecret(env, config.secretKeyEnc);
  return { enabled: config.enabled, publicKey: config.publicKey, secretKey };
}

// --- Order hook -------------------------------------------------------------
// Config storage only in this phase — the firing service + delivery log land in 2D. Mirrors the
// deploy-hook config shape (single URL + optional auth header) with one deliberate difference:
// the auth header VALUE is a credential, so it is encrypted at rest via lib/crypto.ts (the deploy
// hook stores its value in plaintext). The URL stays plaintext in D1 and is masked on read.

/** The order-hook config as stored: the auth header value is held encrypted. */
interface OrderHookConfig {
  url: string;
  authHeaderName?: string;
  /** AES-GCM ciphertext of the auth header value (lib/crypto wire format); absent when unset. */
  authHeaderValueEnc?: string;
  enabled: boolean;
}

const EMPTY_ORDER_HOOK: OrderHookConfig = { url: "", enabled: false };

function parseOrderHook(raw: string | undefined): OrderHookConfig {
  if (!raw) return { ...EMPTY_ORDER_HOOK };
  try {
    const parsed = JSON.parse(raw) as Partial<OrderHookConfig>;
    return {
      url: typeof parsed.url === "string" ? parsed.url : "",
      authHeaderName: typeof parsed.authHeaderName === "string" ? parsed.authHeaderName : undefined,
      authHeaderValueEnc:
        typeof parsed.authHeaderValueEnc === "string" ? parsed.authHeaderValueEnc : undefined,
      enabled: parsed.enabled === true,
    };
  } catch {
    return { ...EMPTY_ORDER_HOOK };
  }
}

async function readOrderHook(db: DrizzleDb): Promise<OrderHookConfig> {
  return parseOrderHook(await getSetting(db, ORDER_HOOK_KEY));
}

/**
 * Merge a PATCH into the stored order-hook config and persist it. PATCH semantics as the deploy
 * hook: an omitted field is unchanged (so `enabled` toggles without resending the auth value);
 * an explicit empty-string `url` clears the whole config. A non-empty `authHeaderValue` is
 * ENCRYPTED (requires SETTINGS_ENC_KEY). An auth header needs both a name and a value — if either
 * ends up missing, both are dropped so the stored shape stays consistent.
 */
export async function setOrderHookConfig(
  db: DrizzleDb,
  env: Env,
  patch: UpdateOrderHookInput,
): Promise<OrderHookSettings> {
  // An explicit empty-string url removes the whole config (rotation/removal).
  if (patch.url !== undefined && patch.url.trim() === "") {
    await setSetting(db, ORDER_HOOK_KEY, JSON.stringify(EMPTY_ORDER_HOOK));
    return toRedactedOrderHook({ ...EMPTY_ORDER_HOOK });
  }

  const next = await readOrderHook(db);

  if (patch.url !== undefined) {
    const url = patch.url.trim();
    const err = validateHookUrl(url);
    if (err) throw validationError(err, { url: err });
    next.url = url;
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.authHeaderName !== undefined) {
    next.authHeaderName = patch.authHeaderName?.trim() || undefined;
  }
  if (patch.authHeaderValue !== undefined) {
    const value = patch.authHeaderValue?.trim();
    // Encrypt only after trimming — the sole key-touching step of the write.
    next.authHeaderValueEnc = value ? await encryptSecret(env, value) : undefined;
  }

  // A header value cannot exist without a name (or vice versa) — keep them paired.
  if (!next.authHeaderName || !next.authHeaderValueEnc) {
    next.authHeaderName = undefined;
    next.authHeaderValueEnc = undefined;
  }

  await setSetting(db, ORDER_HOOK_KEY, JSON.stringify(next));
  return toRedactedOrderHook(next);
}

/** Mask a stored URL to `scheme://host/…/<last4>` — enough to recognize it, not to use it. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…/${url.slice(-4)}`;
  } catch {
    return "";
  }
}

function toRedactedOrderHook(config: OrderHookConfig): OrderHookSettings {
  const configured = config.url !== "";
  const hasAuthHeader = Boolean(config.authHeaderName && config.authHeaderValueEnc);
  return {
    enabled: config.enabled,
    configured,
    urlPreview: configured ? maskUrl(config.url) : "",
    hasAuthHeader,
    authHeaderName: hasAuthHeader ? (config.authHeaderName ?? null) : null,
  };
}

/** Redacted order-hook view for admin reads. Key-free: the auth value is reported only as present/not. */
export async function getRedactedOrderHook(db: DrizzleDb): Promise<OrderHookSettings> {
  return toRedactedOrderHook(await readOrderHook(db));
}

/** The decrypted order-hook config for the firing service (phase 2D). Null when no URL is stored. */
export interface OrderHookRuntimeConfig {
  url: string;
  enabled: boolean;
  authHeaderName?: string;
  /** The plaintext auth header value, decrypted at use-time; absent when no auth header is set. */
  authHeaderValue?: string;
}

/**
 * Resolve the order-hook config with its auth header value DECRYPTED, for the firing service.
 * Returns null when no URL is configured. Requires SETTINGS_ENC_KEY only when an encrypted auth
 * header is present (decryption is skipped entirely for a hook with no auth header). Key-touching.
 */
export async function getOrderHookConfig(
  db: DrizzleDb,
  env: Env,
): Promise<OrderHookRuntimeConfig | null> {
  const config = await readOrderHook(db);
  if (!config.url) return null;
  const authHeaderValue = config.authHeaderValueEnc
    ? await decryptSecret(env, config.authHeaderValueEnc)
    : undefined;
  return {
    url: config.url,
    enabled: config.enabled,
    authHeaderName: config.authHeaderName,
    authHeaderValue,
  };
}

// --- Aggregate view ---------------------------------------------------------

/** The full redacted store-settings bundle for the admin settings page. Key-free. */
export async function getStoreSettings(db: DrizzleDb): Promise<StoreSettings> {
  const [currency, culqi, orderHook] = await Promise.all([
    getStoreCurrency(db),
    getRedactedCulqi(db),
    getRedactedOrderHook(db),
  ]);
  return { currency, culqi, orderHook };
}
