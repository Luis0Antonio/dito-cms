/**
 * Provision and deploy a new, fully isolated Dito CMS instance for one client — from this
 * single clone, no per-client GitHub repo.
 *
 *   bun run new-client acme
 *
 * For client `acme` it: creates the D1 `dito-acme-db` and R2 `dito-acme-media` on your
 * Cloudflare account, writes `clients/acme.jsonc` (the committed config for that client),
 * applies migrations to its remote D1, builds once, and deploys the Worker `dito-acme`.
 * Idempotent: re-running reuses existing resources and just refreshes + redeploys.
 * Requires `wrangler login` first.
 */
import {
  applyMigrations,
  baseHasR2,
  buildOnce,
  client,
  deployClient,
  ensureD1,
  ensureR2,
  parseArgs,
  useAccount,
  writeClientConfig,
  wrangler,
} from "./lib/fleet.ts";

function main(): void {
  const { positionals, accountId } = parseArgs(process.argv.slice(2));
  useAccount(accountId);
  const c = client(positionals[0] ?? "");

  console.warn(`→ Provisioning client "${c.name}" — worker ${c.worker}`);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (account) console.warn(`  Cloudflare account: ${account}`);
  console.warn("\n→ Checking Wrangler authentication…");
  wrangler(["whoami"]);

  console.warn(`\n→ Ensuring D1 database "${c.db}"…`);
  const databaseId = ensureD1(c.db);
  console.warn(`  database_id: ${databaseId}`);

  const hasR2 = baseHasR2();
  if (hasR2) {
    console.warn(`\n→ Ensuring R2 bucket "${c.bucket}"…`);
    ensureR2(c.bucket);
  } else {
    console.warn(
      "\n→ Base config has no R2 binding (Cloudinary mode) — skipping bucket; " +
        "set CLOUDINARY_URL for this client after the first deploy.",
    );
  }

  writeClientConfig(c, databaseId);
  console.warn(`  wrote clients/${c.name}.jsonc`);

  console.warn("\n→ Applying migrations to the remote D1…");
  applyMigrations(c);

  console.warn("\n→ Building (shared) and deploying…");
  buildOnce();
  const url = deployClient(c);

  console.warn(`\n✓ Deployed ${c.worker}.`);
  if (url) console.warn(`  URL: ${url}`);
  console.warn("  The first visit is the /setup first-run screen (create the admin there).");
  if (!hasR2) {
    console.warn(
      `  Store media credentials: printf '%s' 'cloudinary://…' | wrangler secret put CLOUDINARY_URL -c clients/${c.name}.jsonc`,
    );
  }
}

try {
  main();
} catch (error: unknown) {
  console.error("\n✗ new-client failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
