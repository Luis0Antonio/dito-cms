import type { DrizzleDb } from "../db/client";
import { getSetting } from "./settings";

// --- System Admin (vendor-only capability) -----------------------------------
// Raising the media storage limit has billing consequences, so it is gated behind a "System
// Admin" capability that only the vendor holds. Membership lives ONLY in the D1 `settings` row
// below (a comma-separated list of user ids). No API route writes an arbitrary settings key, so
// this row is unreachable through the UI/API — it is grantable solely by a direct database write:
//
//   wrangler d1 execute <DB> --remote --command "INSERT INTO settings (key, value, updated_at)
//     VALUES ('system_admin_user_ids', (SELECT id FROM user WHERE email='vendor@example.com'),
//     unixepoch()*1000) ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
//
// The mutable `user.role` column is deliberately NOT consulted, so a regular admin cannot escalate
// through better-auth's `setRole` (which can write `role` but not this settings row).

export const SYSTEM_ADMIN_USER_IDS_KEY = "system_admin_user_ids";

/** Parse the comma-separated allowlist into a set of trimmed, non-empty user ids. */
function parseUserIds(csv: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!csv) return out;
  for (const part of csv.split(",")) {
    const id = part.trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * Whether `userId` is a System Admin — the authoritative gate for editing the storage limit.
 * Returns false for anonymous/unknown callers. Membership is the D1-only allowlist above.
 */
export async function isSystemAdmin(db: DrizzleDb, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const csv = await getSetting(db, SYSTEM_ADMIN_USER_IDS_KEY);
  return parseUserIds(csv).has(userId);
}
