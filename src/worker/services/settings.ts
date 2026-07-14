import { eq } from "drizzle-orm";

import type { DrizzleDb } from "../db/client";
import { settings } from "../db/schema";
import { validationError } from "../lib/errors";

import { BYTES_PER_GB, DEFAULT_STORAGE_LIMIT_GB, MAX_STORAGE_LIMIT_GB } from "@/shared/constants";

export async function getSetting(db: DrizzleDb, key: string): Promise<string | undefined> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value;
}

export async function setSetting(db: DrizzleDb, key: string, value: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

// --- Commerce module toggle --------------------------------------------------
// The whole optional Store module is gated by a single boolean stored under this key.
// OFF by default so content-only instances are entirely unaffected. Worker routes, MCP
// store tools and the SPA nav all consult this flag.

export const COMMERCE_ENABLED_KEY = "commerce_enabled";

/** Whether the optional commerce (Store) module is enabled. Defaults to false. */
export async function isCommerceEnabled(db: DrizzleDb): Promise<boolean> {
  return (await getSetting(db, COMMERCE_ENABLED_KEY)) === "true";
}

/** Enable or disable the commerce module. */
export async function setCommerceEnabled(db: DrizzleDb, enabled: boolean): Promise<void> {
  await setSetting(db, COMMERCE_ENABLED_KEY, enabled ? "true" : "false");
}

// --- Contact forms module toggle ---------------------------------------------
// The optional Forms (contact forms) module is gated by a single boolean under this key,
// exactly like the commerce toggle above. OFF by default so instances that don't need forms
// are entirely unaffected. Admin routes, the public submission endpoint, the MCP forms toggle
// and the SPA nav all consult this flag.

export const FORMS_ENABLED_KEY = "forms_enabled";

/** Whether the optional Forms (contact forms) module is enabled. Defaults to false. */
export async function isFormsEnabled(db: DrizzleDb): Promise<boolean> {
  return (await getSetting(db, FORMS_ENABLED_KEY)) === "true";
}

/** Enable or disable the contact forms module. */
export async function setFormsEnabled(db: DrizzleDb, enabled: boolean): Promise<void> {
  await setSetting(db, FORMS_ENABLED_KEY, enabled ? "true" : "false");
}

// --- Media storage limit -----------------------------------------------------
// Per-deployment media cap (see DEFAULT_STORAGE_LIMIT_GB). Stored as a plain GB number-string
// under this key; absent → the in-code default, so enforcement is live before anyone sets it.

export const STORAGE_LIMIT_GB_KEY = "storage_limit_gb";

/** The configured storage cap in GB, or the default when unset/unparseable. */
export async function getStorageLimitGb(db: DrizzleDb): Promise<number> {
  const raw = await getSetting(db, STORAGE_LIMIT_GB_KEY);
  if (raw === undefined) return DEFAULT_STORAGE_LIMIT_GB;
  const gb = Number(raw);
  return Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_STORAGE_LIMIT_GB;
}

/** The configured storage cap in bytes (getStorageLimitGb × 1024³). */
export async function getStorageLimitBytes(db: DrizzleDb): Promise<number> {
  return (await getStorageLimitGb(db)) * BYTES_PER_GB;
}

/** Set the storage cap (GB). Validates finite / > 0 / ≤ MAX; decimals are allowed. */
export async function setStorageLimitGb(db: DrizzleDb, gb: number): Promise<void> {
  if (!Number.isFinite(gb) || gb <= 0 || gb > MAX_STORAGE_LIMIT_GB) {
    throw validationError(`\`storageLimitGb\` must be a number between 0 and ${MAX_STORAGE_LIMIT_GB}`, {
      storageLimitGb: `Must be greater than 0 and at most ${MAX_STORAGE_LIMIT_GB} GB`,
    });
  }
  await setSetting(db, STORAGE_LIMIT_GB_KEY, String(gb));
}

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Resolve the Better Auth secret. Env always wins (set via `wrangler secret` or the
 * deploy-button prompt). Otherwise auto-generate once into settings.auth_secret with a
 * race-safe INSERT-OR-IGNORE so button deployers need zero configuration.
 */
export async function getOrCreateAuthSecret(db: DrizzleDb, env: Env): Promise<string> {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  const existing = await getSetting(db, "auth_secret");
  if (existing) return existing;
  const secret = generateSecret();
  await db
    .insert(settings)
    .values({ key: "auth_secret", value: secret, updatedAt: Date.now() })
    .onConflictDoNothing();
  // Re-read in case a concurrent request won the INSERT race.
  return (await getSetting(db, "auth_secret")) ?? secret;
}
