import { z } from "zod";
import { ZodError } from "zod";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { DrizzleDb } from "../db/client";
import { ApiError, zodToFieldErrors } from "../lib/errors";
import {
  createCollection,
  deleteCollection,
  getCollectionDetail,
  listCollections,
  setFields,
  updateCollection,
} from "../services/collections";
import {
  createEntry,
  deleteEntry,
  getEntryDetail,
  listEntries,
  publishEntry,
  unpublishEntry,
  updateEntry,
  type UpdateEntryPatch,
} from "../services/entries";
import { listMedia, uploadMediaFromUrl } from "../services/media";

import { FIELD_TYPE_LIST, type FieldOptions } from "@/shared/field-types";
import { APP_NAME, APP_VERSION } from "@/shared/constants";
import type { EntryData, EntryDetail, MediaDTO } from "@/shared/api-types";

// The MCP toolset: thin wrappers over the same services the admin API uses, so validation,
// publish semantics and media checks are identical. Outputs are deliberately compact (the
// plan caps tool results well under 10k tokens) and lists paginate. Every handler runs
// inside run(), which parses args with the tool's zod schema and renders service errors
// (ApiError + fieldErrors) as readable, non-throwing tool errors the model can act on.

export interface ToolContext {
  db: DrizzleDb;
  env: Env;
  origin: string;
  userId: string | undefined;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  run(ctx: ToolContext, args: unknown): Promise<CallToolResult>;
}

// --- result helpers ----------------------------------------------------------

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

function toToolError(err: unknown): CallToolResult {
  if (err instanceof ApiError) {
    let text = `Error (${err.code}): ${err.message}`;
    const fe = err.fieldErrors;
    if (fe && Object.keys(fe).length > 0) {
      text += "\nField errors:\n" + Object.entries(fe).map(([k, v]) => `  - ${k}: ${v}`).join("\n");
    }
    return { content: [{ type: "text", text }], isError: true };
  }
  if (err instanceof ZodError) {
    const fe = zodToFieldErrors(err);
    const text =
      "Invalid arguments:\n" + Object.entries(fe).map(([k, v]) => `  - ${k}: ${v}`).join("\n");
    return { content: [{ type: "text", text }], isError: true };
  }
  console.error("MCP tool error:", err);
  return { content: [{ type: "text", text: "Internal error processing the tool call." }], isError: true };
}

function defineTool<S extends z.ZodType>(config: {
  name: string;
  description: string;
  schema: S;
  handler: (ctx: ToolContext, args: z.output<S>) => Promise<unknown>;
}): ToolDef {
  return {
    name: config.name,
    description: config.description,
    inputSchema: z.toJSONSchema(config.schema) as Tool["inputSchema"],
    async run(ctx, rawArgs) {
      try {
        const args = config.schema.parse(rawArgs ?? {});
        return ok(await config.handler(ctx, args));
      } catch (err) {
        return toToolError(err);
      }
    },
  };
}

// --- shared arg fragments + mappers ------------------------------------------

const fieldInput = z.object({
  name: z.string().describe("API key for the field — camelCase, e.g. heroTitle. Immutable after create."),
  label: z.string().describe("Human-readable label shown in the editor."),
  type: z.enum(FIELD_TYPE_LIST).describe("Field type. See get_cms_info for the per-type option reference."),
  options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Per-type options, e.g. { required: true, maxLength: 80 }. Omit for none."),
});

const entryData = z
  .record(z.string(), z.unknown())
  .describe(
    "Field values keyed by field name. rich_text accepts a plain string or a TipTap JSON doc; " +
      "picture/video take a media id; link takes { url, label?, newTab? }.",
  );

function toFieldInputs(
  fields: z.output<typeof fieldInput>[],
): { name: string; label: string; type: z.output<typeof fieldInput>["type"]; options?: FieldOptions }[] {
  return fields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    options: f.options as FieldOptions | undefined,
  }));
}

function mediaForMcp(origin: string, m: MediaDTO) {
  return {
    id: m.id,
    kind: m.kind,
    filename: m.filename,
    // m.url is a same-origin relative path today; resolve it against origin so the result is
    // always absolute. Using new URL() (not string concat) keeps it correct even if m.url ever
    // becomes absolute (e.g. a CDN/public-bucket URL) — it would otherwise yield `${origin}https://…`.
    url: new URL(m.url, origin).href,
    mime: m.mime,
    width: m.width,
    height: m.height,
    duration: m.duration,
    alt: m.alt,
    size: m.size,
  };
}

function summarizeEntry(e: EntryDetail, includePublished = false) {
  return {
    id: e.id,
    slug: e.slug,
    status: e.status,
    sortOrder: e.sortOrder,
    publishedAt: e.publishedAt,
    draftUpdatedAt: e.draftUpdatedAt,
    data: e.draftData,
    ...(includePublished ? { published: e.publishedData } : {}),
  };
}

// Compact field-type reference embedded in get_cms_info so an AI can model from a cold start.
const FIELD_TYPE_REFERENCE = [
  { type: "text", stores: "string", options: "multiline, default, placeholder, minLength, maxLength, required, help" },
  {
    type: "rich_text",
    stores: "{ json, html } — pass a plain string OR a TipTap doc; HTML is regenerated server-side",
    options: "placeholder, required, help",
  },
  { type: "number", stores: "number", options: "integer, min, max, default, placeholder, required, help" },
  { type: "boolean", stores: "boolean", options: "default, help" },
  { type: "picture", stores: "media id of an image (use list_media or upload_media_from_url)", options: "required, help" },
  { type: "video", stores: "media id of a video", options: "required, help" },
  { type: "link", stores: "{ url, label?, newTab? }", options: "allowRelative, required, help" },
];

// --- tools -------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  defineTool({
    name: "get_cms_info",
    description:
      "Cold-start overview of this Dito CMS instance: admin + delivery URLs, content counts, the " +
      "current collections, and the field-type reference. Call this first when modelling or populating content.",
    schema: z.object({}),
    handler: async (ctx) => {
      const cols = await listCollections(ctx.db);
      const mediaList = await listMedia(ctx.db, { limit: 1 });
      const entriesTotal = cols.reduce((sum, c) => sum + c.entryCount, 0);
      return {
        name: APP_NAME,
        version: APP_VERSION,
        adminBaseUrl: ctx.origin,
        deliveryApi: {
          schema: `${ctx.origin}/api/v1/collections`,
          collectionList: `${ctx.origin}/api/v1/content/{slug}?limit&offset&sort&filter[field][op]=value`,
          singleton: `${ctx.origin}/api/v1/content/{slug}`,
          item: `${ctx.origin}/api/v1/content/{slug}/{idOrSlug}`,
        },
        counts: { collections: cols.length, entries: entriesTotal, media: mediaList.total },
        collections: cols.map((c) => ({ slug: c.slug, name: c.name, type: c.type, fields: c.fieldCount, entries: c.entryCount })),
        fieldTypes: FIELD_TYPE_REFERENCE,
        notes: [
          "Collections hold many entries; singletons hold exactly one (auto-created on first edit/publish).",
          "Entries are draft → publish. Delivery serves only published data — set publish:true on create_entry, or call publish_entry.",
          "rich_text accepts a plain string (wrapped into paragraphs) or a TipTap JSON document.",
          "picture/video fields store a media id — obtain one via list_media or upload_media_from_url.",
        ],
      };
    },
  }),

  defineTool({
    name: "list_collections",
    description: "List all collections and singletons with their field and entry counts.",
    schema: z.object({}),
    handler: async (ctx) => {
      const cols = await listCollections(ctx.db);
      return cols.map((c) => ({
        slug: c.slug,
        name: c.name,
        type: c.type,
        description: c.description,
        titleField: c.titleField,
        fields: c.fieldCount,
        entries: c.entryCount,
      }));
    },
  }),

  defineTool({
    name: "get_collection",
    description: "Get one collection (or singleton) by slug, including its ordered field definitions.",
    schema: z.object({ slug: z.string().describe("The collection slug.") }),
    handler: async (ctx, args) => {
      const d = await getCollectionDetail(ctx.db, args.slug);
      return {
        slug: d.slug,
        name: d.name,
        type: d.type,
        description: d.description,
        titleField: d.titleField,
        entries: d.entryCount,
        fields: d.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, options: f.options })),
      };
    },
  }),

  defineTool({
    name: "create_collection",
    description:
      "Create a collection (many entries) or singleton (one entry), optionally with its fields in one shot. " +
      "slug and type are immutable after create. See get_cms_info for field types and options.",
    schema: z.object({
      slug: z.string().describe("URL-safe slug, lowercase, e.g. 'testimonials'. Immutable."),
      name: z.string().describe("Display name, e.g. 'Testimonials'."),
      type: z.enum(["collection", "singleton"]).describe("'collection' (many entries) or 'singleton' (one)."),
      description: z.string().optional(),
      fields: z.array(fieldInput).optional().describe("Initial fields. You can also add them later with set_collection_fields."),
    }),
    handler: async (ctx, args) => {
      const d = await createCollection(ctx.db, {
        slug: args.slug,
        name: args.name,
        type: args.type,
        description: args.description ?? null,
        fields: args.fields ? toFieldInputs(args.fields) : undefined,
      });
      return {
        slug: d.slug,
        name: d.name,
        type: d.type,
        fields: d.fields.map((f) => ({ name: f.name, type: f.type })),
      };
    },
  }),

  defineTool({
    name: "update_collection",
    description: "Update a collection's editable metadata (name, description, title field, sort order). slug and type cannot change.",
    schema: z.object({
      slug: z.string(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      titleField: z.string().nullable().optional().describe("Field name used as the list title. null to clear."),
      sortOrder: z.number().optional(),
    }),
    handler: async (ctx, args) => {
      const d = await updateCollection(ctx.db, args.slug, {
        name: args.name,
        description: args.description,
        titleField: args.titleField,
        sortOrder: args.sortOrder,
      });
      return { slug: d.slug, name: d.name, description: d.description, titleField: d.titleField };
    },
  }),

  defineTool({
    name: "set_collection_fields",
    description:
      "Declaratively replace a collection's full field set. The server diffs by field name and returns " +
      "{ added, updated, removed }. Removing a field or changing its type discards stored values, so those " +
      "require allowDestructive: true.",
    schema: z.object({
      slug: z.string(),
      fields: z.array(fieldInput).describe("The complete desired field list (order matters)."),
      allowDestructive: z.boolean().optional().describe("Required to remove fields or change a field's type."),
    }),
    handler: async (ctx, args) => {
      return setFields(ctx.db, args.slug, {
        fields: toFieldInputs(args.fields),
        allowDestructive: args.allowDestructive,
      });
    },
  }),

  defineTool({
    name: "delete_collection",
    description: "Permanently delete a collection and all its entries. Pass confirm equal to the slug to proceed.",
    schema: z.object({
      slug: z.string(),
      confirm: z.string().describe("Must equal the slug to confirm deletion."),
    }),
    handler: async (ctx, args) => {
      await deleteCollection(ctx.db, args.slug, args.confirm);
      return { ok: true, deleted: args.slug };
    },
  }),

  defineTool({
    name: "list_entries",
    description: "List a collection's entries (compact: id, slug, derived status, title preview). Supports status filter, search, and pagination.",
    schema: z.object({
      collection: z.string().describe("Collection slug."),
      status: z.enum(["draft", "published", "changed"]).optional(),
      search: z.string().optional().describe("Substring match over entry content."),
      limit: z.number().int().min(1).max(100).optional().describe("Default 50."),
      offset: z.number().int().min(0).optional(),
    }),
    handler: async (ctx, args) => {
      const r = await listEntries(ctx.db, args.collection, {
        status: args.status,
        search: args.search,
        limit: args.limit,
        offset: args.offset,
      });
      return {
        total: r.total,
        entries: r.entries.map((e) => ({ id: e.id, slug: e.slug, status: e.status, title: e.title, updatedAt: e.updatedAt })),
      };
    },
  }),

  defineTool({
    name: "get_entry",
    description: "Get one entry by id, with its draft data, published data and derived status.",
    schema: z.object({ id: z.string() }),
    handler: async (ctx, args) => summarizeEntry(await getEntryDetail(ctx.db, args.id), true),
  }),

  defineTool({
    name: "create_entry",
    description:
      "Create an entry in a collection (or the sole entry of a singleton). Set publish:true to publish " +
      "immediately (enforces required fields and bounds); otherwise it is saved as a draft.",
    schema: z.object({
      collection: z.string().describe("Collection slug."),
      data: entryData,
      slug: z.string().nullable().optional().describe("Optional URL slug for the entry."),
      publish: z.boolean().optional().describe("Publish on create. Default false (draft)."),
    }),
    handler: async (ctx, args) => {
      const e = await createEntry(
        ctx.db,
        args.collection,
        { data: args.data as EntryData, slug: args.slug, publish: args.publish },
        ctx.userId,
      );
      return summarizeEntry(e);
    },
  }),

  defineTool({
    name: "update_entry",
    description: "Update an entry's draft. Provided fields are merged into the existing draft (draft-schema validated). Call publish_entry to make changes live.",
    schema: z.object({
      id: z.string(),
      data: entryData.optional().describe("Partial field values to merge into the draft."),
      slug: z.string().nullable().optional(),
      sortOrder: z.number().optional(),
    }),
    handler: async (ctx, args) => {
      const patch: UpdateEntryPatch = {};
      if (args.data !== undefined) patch.data = args.data as EntryData;
      if (args.slug !== undefined) patch.slug = args.slug;
      if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder;
      return summarizeEntry(await updateEntry(ctx.db, args.id, patch, ctx.userId));
    },
  }),

  defineTool({
    name: "publish_entry",
    description: "Publish an entry: validate against the publish schema (required fields + bounds) and copy the draft to the live delivery API.",
    schema: z.object({ id: z.string() }),
    handler: async (ctx, args) => summarizeEntry(await publishEntry(ctx.db, args.id, ctx.userId), true),
  }),

  defineTool({
    name: "unpublish_entry",
    description: "Unpublish an entry so it disappears from the delivery API. The draft is kept.",
    schema: z.object({ id: z.string() }),
    handler: async (ctx, args) => summarizeEntry(await unpublishEntry(ctx.db, args.id, ctx.userId), true),
  }),

  defineTool({
    name: "delete_entry",
    description: "Permanently delete an entry. If it was published, it is removed from delivery immediately.",
    schema: z.object({ id: z.string() }),
    handler: async (ctx, args) => {
      await deleteEntry(ctx.db, args.id);
      return { ok: true, deleted: args.id };
    },
  }),

  defineTool({
    name: "list_media",
    description: "List media assets (images and videos) with absolute URLs. Use a returned id as the value of a picture or video field.",
    schema: z.object({
      kind: z.enum(["image", "video"]).optional(),
      search: z.string().optional().describe("Substring match over filename and alt text."),
      limit: z.number().int().min(1).max(100).optional().describe("Default 40."),
      offset: z.number().int().min(0).optional(),
    }),
    handler: async (ctx, args) => {
      const r = await listMedia(ctx.db, { kind: args.kind, search: args.search, limit: args.limit, offset: args.offset });
      return { total: r.total, media: r.media.map((m) => mediaForMcp(ctx.origin, m)) };
    },
  }),

  defineTool({
    name: "upload_media_from_url",
    description:
      "Fetch an image or video from a public URL into the media library and return its id (use that id " +
      "as a picture/video field value). Kind is inferred from the response content type; images cap at 25 MB, videos at 2 GB.",
    schema: z.object({
      url: z.string().describe("Public http(s) URL of the image or video."),
      alt: z.string().optional().describe("Alt text (recommended for images)."),
      filename: z.string().optional().describe("Override the stored filename. Defaults to the URL's basename."),
    }),
    handler: async (ctx, args) => {
      const m = await uploadMediaFromUrl(ctx.db, ctx.env, { url: args.url, alt: args.alt, filename: args.filename }, ctx.userId);
      return mediaForMcp(ctx.origin, m);
    },
  }),
];
