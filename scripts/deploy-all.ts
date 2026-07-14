/**
 * Roll a code update out to EVERY client in one command.
 *
 *   bun run deploy-all
 *
 * Builds once (all clients share the same code), then applies migrations and redeploys
 * each `clients/*.jsonc` in turn. One failing client does not stop the rest; the run exits
 * non-zero if any failed, with a summary at the end.
 */
import { readdirSync } from "node:fs";

import {
  applyMigrations,
  buildOnce,
  client,
  CLIENTS_DIR,
  clientProvider,
  deployClient,
  parseArgs,
  useAccount,
  wrangler,
} from "./lib/fleet.ts";

interface Result {
  worker: string;
  url?: string;
  ok: boolean;
  error?: string;
}

function main(): void {
  const { accountId } = parseArgs(process.argv.slice(2));
  useAccount(accountId);

  let configs: string[] = [];
  try {
    configs = readdirSync(CLIENTS_DIR)
      .filter((f) => f.endsWith(".jsonc") && !f.startsWith("_"))
      .sort();
  } catch {
    /* clients/ does not exist yet */
  }
  if (configs.length === 0) {
    console.warn("No clients found in clients/ — run `bun run new-client <name>` first.");
    return;
  }

  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (account) console.warn(`→ Cloudflare account: ${account}`);
  console.warn("→ Checking Wrangler authentication…");
  wrangler(["whoami"]);

  console.warn(`\n→ Building once for ${configs.length} client(s)…`);
  buildOnce();

  const results: Result[] = [];
  for (const file of configs) {
    const name = file.replace(/\.jsonc$/, "");
    console.warn(`\n──────── ${name} ────────`);
    try {
      const c = client(name);
      console.warn(`  storage: ${clientProvider(c)}`);
      applyMigrations(c);
      const url = deployClient(c);
      results.push({ worker: c.worker, url, ok: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${name} failed: ${message}`);
      results.push({ worker: `dito-${name}`, ok: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.warn(`\n✓ Deployed ${results.length - failed.length}/${results.length} client(s):`);
  for (const r of results) {
    console.warn(`  ${r.ok ? "✓" : "✗"} ${r.worker}${r.url ? ` — ${r.url}` : ""}`);
  }
  if (failed.length > 0) {
    console.error(`\n✗ ${failed.length} client(s) failed.`);
    process.exit(1);
  }
}

try {
  main();
} catch (error: unknown) {
  console.error("\n✗ deploy-all failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
