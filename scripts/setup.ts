/**
 * One-shot provisioning for self-hosters with the Wrangler CLI.
 *
 *   bun run setup
 *
 * Creates the D1 database and R2 bucket on your Cloudflare account, rewrites the real
 * ids into wrangler.jsonc, applies migrations remotely, and (optionally) deploys.
 * Idempotent: re-running reuses existing resources. Requires `wrangler login` first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const WRANGLER_PATH = resolve(ROOT, "wrangler.jsonc");
const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";

function wrangler(args: string[], capture = false): string {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });
}

function readConfigValue(key: string, fallback: string): string {
  const text = readFileSync(WRANGLER_PATH, "utf8");
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
  return match?.[1] ?? fallback;
}

/** Remove the `r2_buckets` binding from wrangler.jsonc so a Cloudinary-only deploy needs no bucket. */
function stripR2Binding(): void {
  const config = readFileSync(WRANGLER_PATH, "utf8");
  const next = config.replace(/\s*"r2_buckets"\s*:\s*\[[\s\S]*?\],?/, "");
  if (next !== config) {
    writeFileSync(WRANGLER_PATH, next);
    console.warn("  removed r2_buckets (no R2 bucket needed for Cloudinary)");
  } else {
    console.warn("  no r2_buckets binding present — nothing to remove");
  }
}

/** Pipe a secret value to `wrangler secret put` (the Worker must already be deployed). */
function setSecret(name: string, value: string): void {
  execFileSync("npx", ["wrangler", "secret", "put", name], {
    cwd: ROOT,
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.warn("→ Checking Wrangler authentication…");
    wrangler(["whoami"]);

    // --- media storage provider ---
    const providerAnswer = (
      await rl.question(
        "\nMedia storage provider:\n  [1] Cloudflare R2 (default)\n  [2] Cloudinary\nChoose [1]: ",
      )
    )
      .trim()
      .toLowerCase();
    const useCloudinary = providerAnswer === "2" || providerAnswer === "cloudinary";
    let cloudinaryUrl = "";
    if (useCloudinary) {
      cloudinaryUrl = (
        await rl.question(
          "\nPaste your CLOUDINARY_URL (cloudinary://<api_key>:<api_secret>@<cloud_name>): ",
        )
      ).trim();
      if (!cloudinaryUrl.startsWith("cloudinary://")) {
        throw new Error(
          "Expected a CLOUDINARY_URL of the form cloudinary://<api_key>:<api_secret>@<cloud_name>.",
        );
      }
    }

    const dbName = readConfigValue("database_name", "dito-cms-db");
    const bucketName = readConfigValue("bucket_name", "dito-cms-media");

    // --- D1 ---
    console.warn(`\n→ Ensuring D1 database "${dbName}"…`);
    let databaseId = "";
    try {
      const list = JSON.parse(wrangler(["d1", "list", "--json"], true)) as { name: string; uuid: string }[];
      databaseId = list.find((d) => d.name === dbName)?.uuid ?? "";
    } catch {
      /* no databases yet */
    }
    if (!databaseId) {
      const created = wrangler(["d1", "create", dbName], true);
      databaseId = /"?database_id"?\s*[:=]\s*"?([0-9a-f-]{36})/i.exec(created)?.[1] ?? "";
      if (!databaseId) {
        databaseId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(created)?.[1] ?? "";
      }
    }
    if (!databaseId) throw new Error("Could not determine the D1 database id from Wrangler output.");
    console.warn(`  database_id: ${databaseId}`);

    // --- patch wrangler.jsonc ---
    const config = readFileSync(WRANGLER_PATH, "utf8");
    if (config.includes(PLACEHOLDER_DB_ID)) {
      writeFileSync(WRANGLER_PATH, config.replace(PLACEHOLDER_DB_ID, databaseId));
      console.warn("  patched wrangler.jsonc with the real database_id");
    }

    // --- media storage ---
    if (useCloudinary) {
      console.warn("\n→ Using Cloudinary — removing the R2 bucket binding from wrangler.jsonc…");
      stripR2Binding();
    } else {
      console.warn(`\n→ Ensuring R2 bucket "${bucketName}"…`);
      try {
        wrangler(["r2", "bucket", "create", bucketName]);
      } catch {
        console.warn("  bucket already exists — continuing");
      }
    }

    // --- migrations ---
    console.warn("\n→ Applying migrations to the remote D1…");
    wrangler(["d1", "migrations", "apply", "DB", "--remote"]);

    // --- deploy ---
    const answer = (await rl.question("\nBuild and deploy now? [y/N] ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      console.warn("\n→ Building and deploying…");
      execFileSync("npx", ["vite", "build"], { cwd: ROOT, stdio: "inherit" });
      wrangler(["deploy"]);
      if (useCloudinary) {
        // Secrets can only be set once the Worker exists, so store it right after the first deploy.
        console.warn("\n→ Storing your Cloudinary credentials as the CLOUDINARY_URL secret…");
        setSecret("CLOUDINARY_URL", cloudinaryUrl);
        console.warn("  ✓ Media now uploads to Cloudinary.");
      }
      console.warn("\n✓ Deployed. Open the workers.dev URL above and complete first-run setup.");
    } else if (useCloudinary) {
      console.warn("\n✓ Provisioned. Run `bun run deploy`, then store your Cloudinary credentials:");
      console.warn(`    printf '%s' '${cloudinaryUrl}' | npx wrangler secret put CLOUDINARY_URL`);
    } else {
      console.warn("\n✓ Provisioned. Run `bun run deploy` when you're ready to ship.");
    }
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error("\n✗ Setup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
