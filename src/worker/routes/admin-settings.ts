import { Hono } from "hono";

import type { AppEnv } from "../lib/app";
import type { DrizzleDb } from "../db/client";
import { getSetting, setSetting, isCommerceEnabled, setCommerceEnabled } from "../services/settings";
import { badRequest } from "../lib/errors";

import { APP_NAME, MAX_LOGO_DATA_URL_BYTES } from "@/shared/constants";
import type { ProjectSettings } from "@/shared/api-types";

// Editable instance settings, mounted under /api/admin/settings (auth applied upstream).
// Holds the project name and an optional brand logo; the key/value `settings` table makes
// adding more trivial.
export const settingsRouter = new Hono<AppEnv>();

async function readProjectName(db: DrizzleDb): Promise<string> {
  return (await getSetting(db, "project_name")) ?? APP_NAME;
}

async function readLogo(db: DrizzleDb): Promise<string | null> {
  const value = await getSetting(db, "project_logo");
  return value ? value : null;
}

async function readSettings(db: DrizzleDb): Promise<ProjectSettings> {
  return {
    projectName: await readProjectName(db),
    logo: await readLogo(db),
    commerceEnabled: await isCommerceEnabled(db),
  };
}

// Normalize a logo value for storage. Empty → cleared. Otherwise it must be an inline image
// data URL or an http(s) URL, within the stored-string size cap.
function normalizeLogo(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const isDataUrl = trimmed.startsWith("data:image/");
  const isHttpUrl = trimmed.startsWith("http://") || trimmed.startsWith("https://");
  if (!isDataUrl && !isHttpUrl) {
    throw badRequest("`logo` must be an image data URL or an http(s) URL");
  }
  if (trimmed.length > MAX_LOGO_DATA_URL_BYTES) {
    throw badRequest("`logo` image is too large");
  }
  return trimmed;
}

settingsRouter.get("/", async (c) => {
  return c.json(await readSettings(c.get("db")));
});

settingsRouter.patch("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = c.get("db");
  if (typeof body.projectName === "string") {
    await setSetting(db, "project_name", body.projectName.trim() || APP_NAME);
  }
  // `logo`: a string sets/clears it; explicit null also clears it (omitted = unchanged).
  if (typeof body.logo === "string") {
    await setSetting(db, "project_logo", normalizeLogo(body.logo));
  } else if (body.logo === null) {
    await setSetting(db, "project_logo", "");
  }
  if (typeof body.commerceEnabled === "boolean") {
    await setCommerceEnabled(db, body.commerceEnabled);
  }
  return c.json(await readSettings(db));
});
