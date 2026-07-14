/**
 * Provision and deploy a new, fully isolated Dito CMS instance for one client — from this
 * single clone, no per-client GitHub repo.
 *
 *   bun run new-client acme                # media on Cloudflare R2 (default)
 *   bun run new-client acme --cloudinary   # media on Cloudinary instead
 *
 * For client `acme` it: creates the D1 `dito-acme-db` (and, for R2 clients, the R2
 * `dito-acme-media`) on your Cloudflare account, writes `clients/acme.jsonc` (that client's
 * config), applies migrations to its remote D1, builds once, and deploys the Worker `dito-acme`.
 * A `--cloudinary` client binds no R2 bucket; its media identity is a per-client CLOUDINARY_URL
 * secret, stored right after the first deploy. Idempotent: re-running reuses existing resources
 * and just refreshes + redeploys. Requires `wrangler login` first.
 */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";

import {
  applyMigrations,
  assertCloudinaryUrl,
  buildOnce,
  client,
  deployClient,
  ensureD1,
  ensureR2,
  parseArgs,
  setCloudinarySecret,
  useAccount,
  writeClientConfig,
  wrangler,
} from "./lib/fleet.ts";

/**
 * Read a value from the terminal with keystroke echo suppressed — for pasting a secret without
 * leaving it in the scrollback. The query itself prints (muting only starts once it is shown), so
 * the user still sees what they're answering.
 */
function promptHidden(query: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: true });
  return new Promise<string>((resolvePrompt) => {
    rl.question(query, (answer) => {
      rl.close();
      stdout.write("\n");
      resolvePrompt(answer);
    });
    muted = true;
  });
}

/**
 * Resolve the client's CLOUDINARY_URL WITHOUT leaking it into argv or shell history: prefer the
 * `$CLOUDINARY_URL` env var (ideal for CI — no echo at all), else a muted interactive prompt.
 */
async function resolveCloudinaryUrl(): Promise<string> {
  const fromEnv = process.env.CLOUDINARY_URL?.trim();
  if (fromEnv) {
    console.warn("  reading CLOUDINARY_URL from the environment");
    return fromEnv;
  }
  return (
    await promptHidden("  Paste this client's CLOUDINARY_URL (cloudinary://<api_key>:<api_secret>@<cloud_name>): ")
  ).trim();
}

async function main(): Promise<void> {
  const { positionals, accountId, cloudinary } = parseArgs(process.argv.slice(2));
  useAccount(accountId);
  const c = client(positionals[0] ?? "");
  const provider = cloudinary ? "cloudinary" : "r2";

  console.warn(`→ Provisioning client "${c.name}" — worker ${c.worker} (storage: ${provider})`);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (account) console.warn(`  Cloudflare account: ${account}`);

  // Cloudinary: resolve + validate the URL BEFORE any infra, so a bad/missing value creates
  // nothing (a Cloudinary worker with no valid credentials would fail every media op).
  let cloudinaryUrl = "";
  if (cloudinary) {
    console.warn("\n→ Resolving this client's Cloudinary credentials…");
    cloudinaryUrl = await resolveCloudinaryUrl();
    assertCloudinaryUrl(cloudinaryUrl);
    console.warn("  ✓ CLOUDINARY_URL looks valid.");
  }

  console.warn("\n→ Checking Wrangler authentication…");
  wrangler(["whoami"]);

  console.warn(`\n→ Ensuring D1 database "${c.db}"…`);
  const databaseId = ensureD1(c.db);
  console.warn(`  database_id: ${databaseId}`);

  if (cloudinary) {
    console.warn("\n→ Cloudinary client — no R2 bucket needed; media goes to Cloudinary.");
  } else {
    console.warn(`\n→ Ensuring R2 bucket "${c.bucket}"…`);
    ensureR2(c.bucket);
  }

  writeClientConfig(c, databaseId, provider);
  console.warn(`  wrote clients/${c.name}.jsonc`);

  console.warn("\n→ Applying migrations to the remote D1…");
  applyMigrations(c);

  console.warn("\n→ Building (shared) and deploying…");
  buildOnce();
  const url = deployClient(c);

  // Secrets attach to a live worker, so store CLOUDINARY_URL only after a successful deploy.
  if (cloudinary) {
    console.warn("\n→ Storing CLOUDINARY_URL as this client's Worker secret…");
    try {
      setCloudinarySecret(c, cloudinaryUrl);
      console.warn("  ✓ Media for this client now uploads to Cloudinary.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ Could not set the secret automatically: ${message}`);
      console.error(
        `    Set it by hand: printf '%s' '<your CLOUDINARY_URL>' | npx wrangler secret put CLOUDINARY_URL -c clients/${c.name}.jsonc`,
      );
      console.error("    Until then this client has NO working media storage.");
    }
  }

  console.warn(`\n✓ Deployed ${c.worker} (storage: ${provider}).`);
  if (url) console.warn(`  URL: ${url}`);
  console.warn("  The first visit is the /setup first-run screen (create the admin there).");
}

main().catch((error: unknown) => {
  console.error("\n✗ new-client failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
