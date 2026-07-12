/**
 * Redeploy ONE existing client — pick up a code update, schema change, or new migration.
 *
 *   bun run deploy-client acme
 *
 * Applies any pending migrations to the client's remote D1, builds, and redeploys the
 * Worker `dito-acme` from `clients/acme.jsonc`. Provision a client first with
 * `bun run new-client <name>`.
 */
import { existsSync } from "node:fs";

import { applyMigrations, buildOnce, client, deployClient, parseArgs, useAccount, wrangler } from "./lib/fleet.ts";

function main(): void {
  const { positionals, accountId } = parseArgs(process.argv.slice(2));
  useAccount(accountId);
  const c = client(positionals[0] ?? "");
  if (!existsSync(c.config)) {
    throw new Error(`No clients/${c.name}.jsonc — run \`bun run new-client ${c.name}\` first.`);
  }

  console.warn(`→ Redeploying ${c.worker}…`);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (account) console.warn(`  Cloudflare account: ${account}`);
  console.warn("\n→ Checking Wrangler authentication…");
  wrangler(["whoami"]);

  console.warn("\n→ Applying migrations to the remote D1…");
  applyMigrations(c);

  console.warn("\n→ Building and deploying…");
  buildOnce();
  const url = deployClient(c);

  console.warn(`\n✓ Redeployed ${c.worker}.`);
  if (url) console.warn(`  URL: ${url}`);
}

try {
  main();
} catch (error: unknown) {
  console.error("\n✗ deploy-client failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
