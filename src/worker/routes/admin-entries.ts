import { Hono } from "hono";

import type { AppEnv } from "../lib/app";
import { badRequest } from "../lib/errors";
import { fireDeployHook } from "./admin-deploy-hook";
import {
  createEntry,
  deleteEntry,
  discardDraft,
  getEntryDetail,
  getEntryRef,
  getOrCreateSingletonEntry,
  listEntries,
  publishEntry,
  reorderEntries,
  unpublishEntry,
  updateEntry,
} from "../services/entries";
import { getEntryUsage } from "../services/references";

import type { EntryData, EntryStatus } from "@/shared/api-types";

// Admin entry endpoints. Split into two routers because some are collection-scoped
// (`/collections/:slug/entries`) and some are entry-scoped (`/entries/:id`). Both are
// mounted under /api/admin by the parent adminRouter (auth already applied there).

function asObject(value: unknown): EntryData | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as EntryData)
    : undefined;
}

function parseStatus(value: string | undefined): EntryStatus | undefined {
  return value === "draft" || value === "published" || value === "changed" ? value : undefined;
}

// --- collection-scoped: /collections/:slug/... -------------------------------

export const collectionEntriesRouter = new Hono<AppEnv>();

collectionEntriesRouter.get("/:slug/entries", async (c) => {
  const limit = Number(c.req.query("limit"));
  const offset = Number(c.req.query("offset"));
  const result = await listEntries(c.get("db"), c.req.param("slug"), {
    status: parseStatus(c.req.query("status")),
    search: c.req.query("search") ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
  });
  return c.json(result);
});

collectionEntriesRouter.post("/:slug/entries", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const data = asObject(body.data);
  if (data === undefined) throw badRequest("`data` must be an object");
  const detail = await createEntry(
    c.get("db"),
    c.req.param("slug"),
    {
      data,
      slug: typeof body.slug === "string" ? body.slug : body.slug === null ? null : undefined,
      publish: body.publish === true,
    },
    c.get("authUserId"),
  );
  // Published-content change → notify the deploy hook (only when actually published).
  if (body.publish === true) {
    fireDeployHook(c, { event: "entry.create", detail: c.req.param("slug") });
  }
  return c.json({ entry: detail }, 201);
});

collectionEntriesRouter.post("/:slug/entries/reorder", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
  if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
    throw badRequest("`ids` must be an array of entry ids");
  }
  await reorderEntries(c.get("db"), c.req.param("slug"), body.ids as string[]);
  fireDeployHook(c, { event: "entry.reorder", detail: c.req.param("slug") });
  return c.json({ ok: true });
});

// Idempotent get-or-create of a singleton's sole entry (used to bootstrap its editor).
collectionEntriesRouter.get("/:slug/singleton", async (c) => {
  const detail = await getOrCreateSingletonEntry(c.get("db"), c.req.param("slug"), c.get("authUserId"));
  return c.json({ entry: detail });
});

// --- entry-scoped: /entries/:id/... ------------------------------------------

export const entriesRouter = new Hono<AppEnv>();

// Lightweight resolved reference target (title/slug/status) for the reference field preview.
entriesRouter.get("/:id/ref", async (c) => {
  const ref = await getEntryRef(c.get("db"), c.req.param("id"));
  return c.json({ ref });
});

// Which other entries reference this one — powers the pre-delete "N entries link here" warning
// (mirrors GET /media/:id/usage). Referrers keep resolving that field to null once it's gone.
entriesRouter.get("/:id/usage", async (c) => {
  return c.json(await getEntryUsage(c.get("db"), c.req.param("id")));
});

entriesRouter.get("/:id", async (c) => {
  const detail = await getEntryDetail(c.get("db"), c.req.param("id"));
  return c.json({ entry: detail });
});

entriesRouter.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { data?: EntryData; slug?: string | null; sortOrder?: number } = {};
  if ("data" in body) {
    const data = asObject(body.data);
    if (data === undefined) throw badRequest("`data` must be an object");
    patch.data = data;
  }
  if ("slug" in body) patch.slug = typeof body.slug === "string" ? body.slug : null;
  if ("sortOrder" in body && typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;

  const detail = await updateEntry(c.get("db"), c.req.param("id"), patch, c.get("authUserId"));
  return c.json({ entry: detail });
});

entriesRouter.post("/:id/publish", async (c) => {
  const detail = await publishEntry(c.get("db"), c.req.param("id"), c.get("authUserId"));
  fireDeployHook(c, { event: "entry.publish", detail: detail.slug });
  return c.json({ entry: detail });
});

entriesRouter.post("/:id/unpublish", async (c) => {
  const detail = await unpublishEntry(c.get("db"), c.req.param("id"), c.get("authUserId"));
  fireDeployHook(c, { event: "entry.unpublish", detail: detail.slug });
  return c.json({ entry: detail });
});

entriesRouter.post("/:id/discard", async (c) => {
  const detail = await discardDraft(c.get("db"), c.req.param("id"), c.get("authUserId"));
  return c.json({ entry: detail });
});

entriesRouter.delete("/:id", async (c) => {
  const { wasPublished } = await deleteEntry(c.get("db"), c.req.param("id"));
  // Deleting a live entry removes it from the delivery API → notify the deploy hook.
  if (wasPublished) fireDeployHook(c, { event: "entry.delete" });
  return c.body(null, 204);
});
