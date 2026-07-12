/**
 * Shared helpers for running ONE Dito CMS codebase as a fleet of isolated,
 * per-client Cloudflare deployments. Used by new-client / deploy-client / deploy-all.
 *
 * Each client is a fully isolated instance — its own Worker `dito-<name>`, D1
 * `dito-<name>-db` and R2 `dito-<name>-media` — all from this single clone. Binding
 * names stay DB / MEDIA, so no application code changes per client.
 *
 * Two non-obvious facts drive the design (both verified against wrangler 4 +
 * @cloudflare/vite-plugin 1.x — see README "Managing multiple clients"):
 *
 *  1. `clients/<name>.jsonc` is the committed source of truth for a client: a copy of
 *     the base wrangler.jsonc with `name` + resource ids swapped. It is used for
 *     migrations, where its `migrations_dir` is rewritten to "../migrations" so wrangler
 *     resolves it from clients/ back to the repo-root migrations folder.
 *
 *  2. Deploy reuses ONE shared `vite build`. The Cloudflare Vite plugin bakes the BASE
 *     name/bindings into `dist/<worker>/wrangler.json` and writes a redirect that a bare
 *     `wrangler deploy` follows. We rewrite that generated config with the client's
 *     identity and deploy bare — so N clients share a single build. Passing
 *     `-c clients/<name>.jsonc` to `wrangler deploy` does NOT work: it bypasses the build
 *     and mis-resolves `main`/assets relative to clients/.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const BASE_WRANGLER = resolve(ROOT, "wrangler.jsonc");
export const CLIENTS_DIR = resolve(ROOT, "clients");
/** Written by the Cloudflare Vite plugin; points a bare `wrangler deploy` at the dist config. */
const DEPLOY_REDIRECT = resolve(ROOT, ".wrangler/deploy/config.json");

/** Run `npx wrangler …`. capture=true returns stdout; otherwise output streams to the console. */
export function wrangler(args: string[], capture = false): string {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });
}

/** Run a local bin (e.g. vite) with inherited stdio. */
export function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
}

export interface FleetArgs {
  positionals: string[];
  accountId?: string;
}

/**
 * Split argv into positionals and an optional Cloudflare account: `--account <id>`
 * (alias `--account-id`, also `--account=<id>`). Targets a specific account when your
 * `wrangler login` has more than one; apply it with useAccount().
 */
export function parseArgs(argv: string[]): FleetArgs {
  const positionals: string[] = [];
  let accountId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const inline = /^--account(?:-id)?=(.+)$/.exec(arg);
    if (arg === "--account" || arg === "--account-id") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires an account id value.`);
      accountId = value;
    } else if (inline) {
      accountId = inline[1];
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, accountId };
}

/**
 * Point every subsequent wrangler call at a specific account. Wrangler has no uniform
 * `--account-id` flag across d1/r2/deploy, but it natively reads CLOUDFLARE_ACCOUNT_ID,
 * which child processes inherit from this one — so the `--account` flag just sets it here.
 */
export function useAccount(accountId: string | undefined): void {
  if (accountId) process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
}

export interface Client {
  name: string; // acme
  worker: string; // dito-acme
  db: string; // dito-acme-db
  bucket: string; // dito-acme-media
  config: string; // absolute path to clients/acme.jsonc
}

// Worker names must be lowercase alphanumeric + hyphens, no leading/trailing hyphen.
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// `dito-cms` is the base instance shipped in wrangler.jsonc — never let a client clobber it.
const RESERVED = new Set(["cms"]);

/** Validate a client name and derive its worker / D1 / R2 / config names. */
export function client(raw: string): Client {
  const name = raw.trim().toLowerCase();
  if (!name) {
    throw new Error("A client name is required, e.g. `bun run new-client acme`.");
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid client name "${raw}". Use lowercase letters, digits and hyphens ` +
        "(no leading/trailing hyphen), e.g. `acme` or `acme-co`.",
    );
  }
  if (RESERVED.has(name)) {
    throw new Error(`"${name}" is reserved — dito-${name} is the base instance.`);
  }
  if (`dito-${name}`.length > 63) {
    throw new Error(`Client name "${name}" is too long — worker name exceeds 63 characters.`);
  }
  return {
    name,
    worker: `dito-${name}`,
    db: `dito-${name}-db`,
    bucket: `dito-${name}-media`,
    config: resolve(CLIENTS_DIR, `${name}.jsonc`),
  };
}

/** Read the string value of a top-level `"key": "value"` from a wrangler(.jsonc) text blob. */
export function readKey(text: string, key: string): string | undefined {
  return new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text)?.[1];
}

/** Replace the value of `"key": "…"` in a wrangler(.jsonc) text blob. Throws if the key is absent. */
function setKey(text: string, key: string, value: string): string {
  const re = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`);
  if (!re.test(text)) throw new Error(`Config key "${key}" not found.`);
  return text.replace(re, `$1${value}$2`);
}

/** True if the base wrangler.jsonc still binds an R2 bucket (Cloudinary setups strip it). */
export function baseHasR2(): boolean {
  return /"r2_buckets"\s*:/.test(readFileSync(BASE_WRANGLER, "utf8"));
}

/**
 * Write clients/<name>.jsonc from the base wrangler.jsonc, swapping in the client's name
 * and resource ids. Idempotent — overwrites/refreshes on re-run. Rewrites `database_id`
 * by its key (not a fixed placeholder), so it is correct even if `bun run setup` has
 * already baked a real id into the base config.
 */
export function writeClientConfig(c: Client, databaseId: string): void {
  let text = readFileSync(BASE_WRANGLER, "utf8");
  text = setKey(text, "name", c.worker);
  text = setKey(text, "database_name", c.db);
  text = setKey(text, "database_id", databaseId);
  if (readKey(text, "bucket_name")) text = setKey(text, "bucket_name", c.bucket);
  // migrations_dir sits at repo root; from clients/ it must resolve back up one level.
  if (readKey(text, "migrations_dir")) {
    text = setKey(text, "migrations_dir", "../migrations");
  } else {
    console.warn(
      `  ⚠ base wrangler.jsonc has no migrations_dir — add "migrations_dir": "../migrations" to clients/${c.name}.jsonc`,
    );
  }
  mkdirSync(CLIENTS_DIR, { recursive: true });
  writeFileSync(c.config, text);
}

/** Find the client's D1 database (by name) or create it; returns its id. Reuses `bun run setup`'s parsing. */
export function ensureD1(dbName: string): string {
  let id = "";
  try {
    const list = JSON.parse(wrangler(["d1", "list", "--json"], true)) as { name: string; uuid: string }[];
    id = list.find((d) => d.name === dbName)?.uuid ?? "";
  } catch {
    /* no databases on the account yet */
  }
  if (!id) {
    const created = wrangler(["d1", "create", dbName], true);
    id = /"?database_id"?\s*[:=]\s*"?([0-9a-f-]{36})/i.exec(created)?.[1] ?? "";
    if (!id) {
      id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(created)?.[1] ?? "";
    }
  }
  if (!id) throw new Error(`Could not determine the D1 database id for "${dbName}".`);
  return id;
}

/** Create the client's R2 bucket, tolerating "already exists". */
export function ensureR2(bucket: string): void {
  try {
    wrangler(["r2", "bucket", "create", bucket]);
  } catch {
    console.warn(`  bucket "${bucket}" already exists — continuing`);
  }
}

/** Apply pending migrations to the client's REMOTE D1 (idempotent — only unapplied migrations run). */
export function applyMigrations(c: Client): void {
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", c.config]);
}

/** One shared production build. Bakes the BASE identity into dist/; deployClient() rewrites it per client. */
export function buildOnce(): void {
  run("npx", ["vite", "build"]);
}

/** Absolute path to the deploy config the Cloudflare Vite plugin generated under dist/. */
function generatedDeployConfig(): string {
  if (!existsSync(DEPLOY_REDIRECT)) {
    throw new Error("No build found under dist/ — call buildOnce() (vite build) first.");
  }
  const redirect = JSON.parse(readFileSync(DEPLOY_REDIRECT, "utf8")) as { configPath: string };
  return resolve(DEPLOY_REDIRECT, "..", redirect.configPath);
}

interface GeneratedConfig {
  name: string;
  d1_databases?: { binding: string; database_name: string; database_id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
}

/**
 * Rewrite the shared build's generated dist config with a client's identity (name + D1/R2
 * bindings), in place, so a bare `wrangler deploy` ships AS that client. Split out from
 * deployClient() so it can be dry-run verified without an actual deploy.
 */
export function patchDeployConfig(c: Client): void {
  const generated = generatedDeployConfig();
  const cfg = JSON.parse(readFileSync(generated, "utf8")) as GeneratedConfig;
  const databaseId = readKey(readFileSync(c.config, "utf8"), "database_id");
  if (!databaseId) throw new Error(`No database_id in ${c.config} — regenerate it with new-client.`);

  cfg.name = c.worker;
  if (cfg.d1_databases?.[0]) {
    cfg.d1_databases[0].database_name = c.db;
    cfg.d1_databases[0].database_id = databaseId;
  }
  if (cfg.r2_buckets?.[0]) cfg.r2_buckets[0].bucket_name = c.bucket;
  writeFileSync(generated, JSON.stringify(cfg));
}

/**
 * Deploy the current shared build AS a given client. Assumes buildOnce() has run and the
 * client's D1/R2 already exist. Returns the deployed workers.dev URL if wrangler printed one.
 */
export function deployClient(c: Client): string | undefined {
  patchDeployConfig(c);

  // Merge stderr→stdout so we can echo everything and still extract the deployed URL.
  let out: string;
  try {
    out = execSync("npx wrangler deploy 2>&1", { cwd: ROOT, encoding: "utf8" });
  } catch (error: unknown) {
    const captured = (error as { stdout?: string }).stdout;
    if (captured) process.stdout.write(captured);
    throw new Error(`wrangler deploy failed for ${c.worker}.`);
  }
  process.stdout.write(out);
  return /(https:\/\/[^\s]+\.workers\.dev)/.exec(out)?.[1];
}
