import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { apiKey } from "@better-auth/api-key";
import { count } from "drizzle-orm";

import type { DrizzleDb } from "./db/client";
import * as authSchema from "./db/auth-schema";
import { getOrCreateAuthSecret } from "./services/settings";

// Once a user exists, signup stays closed for the life of the isolate — memoize the
// "true" direction so we skip the COUNT(*) on every request after first-run.
let signupClosed = false;
// The secret is stable per deployment; resolve it once per isolate.
let cachedSecret: string | undefined;

async function isSignupDisabled(db: DrizzleDb): Promise<boolean> {
  if (signupClosed) return true;
  const row = await db.select({ value: count() }).from(authSchema.user).get();
  if ((row?.value ?? 0) > 0) {
    signupClosed = true;
    return true;
  }
  return false;
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;

/**
 * Per-request Better Auth instance. Bindings are request-scoped, so this is rebuilt
 * each request: baseURL/trustedOrigins follow the incoming origin (any domain works
 * zero-config), secure cookies only on https (Vite dev is http), signup disabled once
 * the first admin exists. Invite-only / no-roles is modelled as everyone-is-admin.
 */
export async function createAuth(db: DrizzleDb, env: Env, origin: string) {
  const [secret, disableSignUp] = await Promise.all([
    cachedSecret ?? getOrCreateAuthSecret(db, env).then((s) => (cachedSecret = s)),
    isSignupDisabled(db),
  ]);
  const isHttps = origin.startsWith("https://");

  return betterAuth({
    baseURL: origin,
    secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp,
      minPasswordLength: 8,
    },
    // NOTE: brute-force protection for sign-in/sign-up is NOT configured here. Better Auth's
    // core `rateLimit` is left off on purpose — it defaults to in-memory storage, which on
    // Workers is per-isolate and ephemeral, and its `enabled` default keys off
    // `process.env.NODE_ENV === "production"`, unset in workerd. The real throttle is durable
    // and D1-backed: middleware/auth-rate-limit.ts, wired in index.ts.
    advanced: {
      useSecureCookies: isHttps,
    },
    plugins: [
      admin({ defaultRole: "admin", adminRoles: ["admin"] }),
      apiKey({
        defaultPrefix: "dito_",
        startingCharactersConfig: { shouldStore: true, charactersLength: 12 },
        // Keys are admin-issued and used for high-volume, trusted callers: the delivery
        // sites' authenticated reads, the MCP server (an AI fires many calls per task), and
        // CI. The plugin's default per-key cap is 10 requests/day, which would silently brick
        // all of that after a handful of calls. Disable it (checked at verify time, so it
        // covers already-created keys too); the Cloudflare edge handles abuse/DDoS.
        rateLimit: { enabled: false },
      }),
    ],
  });
}
