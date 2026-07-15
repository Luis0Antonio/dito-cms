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
import { getEntryUsage, migrateStringFieldToReference } from "../services/references";
import {
  isCommerceEnabled,
  setCommerceEnabled,
  isFormsEnabled,
  setFormsEnabled,
  getContentLocales,
  setContentLocales,
} from "../services/settings";
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
} from "../services/store/products";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "../services/store/categories";
import { getProductFields, setProductFields } from "../services/store/product-schema";

import { FIELD_TYPE_LIST, type FieldOptions } from "@/shared/field-types";
import { isLocalized } from "@/shared/localization";
import { APP_NAME, APP_VERSION } from "@/shared/constants";
import type { CategoryDTO, EntryData, EntryDetail, MediaDTO, ProductDetail, ProductStatus } from "@/shared/api-types";

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
      "picture/video take a media id; link takes { url, label?, newTab? }; reference takes a target " +
      "entry id or slug (an array when multiple:true); select takes one of the field's preset choice strings. " +
      "LOCALIZED fields (options.localized is true — check get_collection; only text/rich_text/number/boolean/" +
      "link/select can be localized) take a per-language MAP { [locale]: value } instead of a bare value, e.g. " +
      '{ "es": "Hola", "en": "Hello" }, where each key is a configured locale code from get_cms_info ' +
      "(localization.locales). You may fill only some languages — a missing translation falls back to the " +
      "default locale at delivery; a REQUIRED localized field needs at least the default-locale value to " +
      "publish. Writing an unconfigured/typo'd locale code is accepted silently, so use only codes from " +
      "localization.locales. Non-localized fields (and all picture/video/reference) always take a bare value.",
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
// `localized` (text/rich_text/number/boolean/link/select only) makes a field store a per-language
// { [locale]: value } map; see the localization block + notes in get_cms_info.
const FIELD_TYPE_REFERENCE = [
  { type: "text", stores: "string", options: "multiline, default, placeholder, minLength, maxLength, required, localized, help" },
  {
    type: "rich_text",
    stores: "{ json, html } — pass a plain string OR a TipTap doc; HTML is regenerated server-side",
    options: "placeholder, required, localized, help",
  },
  { type: "number", stores: "number", options: "integer, min, max, default, placeholder, required, localized, help" },
  { type: "boolean", stores: "boolean", options: "default, localized, help" },
  { type: "picture", stores: "media id of an image (use list_media or upload_media_from_url)", options: "required, help" },
  { type: "video", stores: "media id of a video", options: "required, help" },
  { type: "link", stores: "{ url, label?, newTab? }", options: "allowRelative, required, localized, help" },
  {
    type: "reference",
    stores:
      "a target entry id — or an array of ids when multiple:true. You may pass a target entry SLUG instead of an id; it is resolved automatically. Delivery returns it expanded as { id, slug, title, collection }.",
    options: "targetCollections (allowed target collection slugs; [] or [\"*\"] = any), multiple, required, help",
  },
  {
    type: "select",
    stores: "a string that must be one of the field's preset `choices` (enforced at publish)",
    options: "choices (the preset options; at least one, required), default (must be one of choices), placeholder, required, localized, help",
  },
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
      const commerceEnabled = await isCommerceEnabled(ctx.db);
      const formsEnabled = await isFormsEnabled(ctx.db);
      const localeConfig = await getContentLocales(ctx.db);
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
        // Optional Store module. When enabled, the store_* tools below become available and the
        // catalog is served (uncached) under /api/commerce/*. Toggle with set_store_enabled.
        store: { enabled: commerceEnabled },
        // Optional Forms (contact forms) module. When enabled, the admin forms UI and the public
        // submission endpoint (/api/v1/contact-forms/{key}/submissions) become active. OFF by
        // default. Toggle with set_forms_enabled.
        forms: { enabled: formsEnabled },
        // Field-level content localization. `locales` is the set of configured language codes and
        // `default` is the fallback delivered when a translation is missing. A field with
        // options.localized:true stores a per-language { [locale]: value } map. Read/change the set
        // with get_content_locales / add_content_locale.
        localization: { locales: localeConfig.locales, default: localeConfig.default },
        notes: [
          "Collections hold many entries; singletons hold exactly one (auto-created on first edit/publish).",
          "Entries are draft → publish. Delivery serves only published data — set publish:true on create_entry, or call publish_entry.",
          "rich_text accepts a plain string (wrapped into paragraphs) or a TipTap JSON document.",
          "picture/video fields store a media id — obtain one via list_media or upload_media_from_url.",
          "reference fields link entries across collections: pass a target entry id or slug (an array when multiple). Delivery returns them expanded with the target's title; a required reference to an unpublished target is blocked at publish.",
          "Multi-language: a field marked localized (options.localized:true, text/rich_text/number/boolean/link/select only) stores a value per language. Author it by passing a { [locale]: value } map (e.g. { es, en }) to create_entry/update_entry; delivery serves one language via ?locale= and falls back to the default. Add languages with add_content_locale; read them here or via get_content_locales.",
        ],
      };
    },
  }),

  defineTool({
    name: "set_store_enabled",
    description:
      "Enable or disable the optional Store (commerce) module. When enabled, the store_* tools " +
      "(products, categories, product schema) become available and the public catalog is served " +
      "under /api/commerce/*. OFF by default. This tool is always available regardless of the toggle.",
    schema: z.object({
      enabled: z.boolean().describe("true to enable the Store module, false to disable it."),
    }),
    handler: async (ctx, args) => {
      await setCommerceEnabled(ctx.db, args.enabled);
      return { store: { enabled: args.enabled } };
    },
  }),

  defineTool({
    name: "set_forms_enabled",
    description:
      "Enable or disable the optional Forms (contact forms) module. When enabled, the admin " +
      "forms UI is shown and the public submission endpoint (/api/v1/contact-forms/{key}/submissions) " +
      "accepts submissions. OFF by default. This tool is always available regardless of the toggle.",
    schema: z.object({
      enabled: z.boolean().describe("true to enable the Forms module, false to disable it."),
    }),
    handler: async (ctx, args) => {
      await setFormsEnabled(ctx.db, args.enabled);
      return { forms: { enabled: args.enabled } };
    },
  }),

  defineTool({
    name: "get_content_locales",
    description:
      "Get the content languages available for field-level localization: `locales` (the configured " +
      "language codes) and `default` (the fallback delivered when a translation is missing). A field " +
      "marked localized (options.localized:true) stores a value per language. Add languages with " +
      "add_content_locale. Also included in get_cms_info under `localization`.",
    schema: z.object({}),
    handler: async (ctx) => {
      const config = await getContentLocales(ctx.db);
      return { locales: config.locales, default: config.default };
    },
  }),

  defineTool({
    name: "add_content_locale",
    description:
      "Add a content language for field-level localization. Safe and additive: it only appends to the " +
      "current set — it never removes a language or touches stored content, so existing translations are " +
      "always preserved. `locale` is a BCP-47-ish code (e.g. 'en', 'pt-BR'); adding one that already " +
      "exists is a no-op for the list. Set makeDefault:true to also make it the default/fallback language " +
      "(works whether the locale is new or already present — this is how you change the default). After " +
      "adding a language, mark fields localized (options.localized:true via set_collection_fields) and " +
      "fill each language by passing a { [locale]: value } map to create_entry/update_entry. Returns the " +
      "updated { locales, default }. (Removing a language is intentionally a deliberate admin-UI action, " +
      "since it would orphan that language's stored content.)",
    schema: z.object({
      locale: z.string().describe("Language code to add, e.g. 'en' or 'pt-BR'. BCP-47-ish (es, en, pt-BR)."),
      makeDefault: z
        .boolean()
        .optional()
        .describe("Also make this the default/fallback language. Default false."),
    }),
    handler: async (ctx, args) => {
      const current = await getContentLocales(ctx.db);
      const locales = current.locales.includes(args.locale)
        ? current.locales
        : [...current.locales, args.locale];
      const config = await setContentLocales(ctx.db, {
        locales,
        default: args.makeDefault ? args.locale : current.default,
      });
      return { locales: config.locales, default: config.default };
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
        fields: d.fields.map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          options: f.options,
          // Explicit convenience flag: true when this field stores a per-language { [locale]: value }
          // map. Author such fields by passing a locale map to create_entry/update_entry.
          localized: isLocalized({ type: f.type, options: f.options }),
        })),
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
    name: "migrate_string_field_to_reference",
    description:
      "Backfill a reference field from a legacy 'link by name' text field. For each entry in " +
      "`collection`, the `fromField` string is matched (trimmed, case-insensitive) against the " +
      "titles in `targetCollection` and the resolved entry id is written into `toField` (which must " +
      "already exist as a reference field — create it first with set_collection_fields). Draft AND " +
      "published copies are converted; targets are NOT publish-checked, so a required reference onto an " +
      "unpublished target delivers null until that target goes live (publish targets first). Returns " +
      "{ converted, unmatched, ambiguous }: an ambiguous name " +
      "(two+ targets share it) is left unconverted, never guessed. Reconcile unmatched/ambiguous by " +
      "hand, then drop the old field with set_collection_fields(allowDestructive: true).",
    schema: z.object({
      collection: z.string().describe("Slug of the collection whose entries hold the name strings."),
      fromField: z.string().describe("Existing field holding the target's name/title (read as a string)."),
      toField: z.string().describe("The reference field to populate. Must already exist on the collection."),
      targetCollection: z
        .string()
        .describe("Slug of the collection the names point at; its title field is matched. Must have a title field set."),
    }),
    handler: async (ctx, args) => {
      const { result } = await migrateStringFieldToReference(ctx.db, {
        collectionSlug: args.collection,
        fromField: args.fromField,
        toField: args.toField,
        targetCollectionSlug: args.targetCollection,
      });
      // Cap the per-row lists so a large collection can't blow the tool-result token budget;
      // the counts stay exact and the admin API returns the full lists if needed.
      const CAP = 50;
      const truncated = result.unmatched.length > CAP || result.ambiguous.length > CAP;
      return {
        converted: result.converted,
        unmatchedCount: result.unmatched.length,
        ambiguousCount: result.ambiguous.length,
        unmatched: result.unmatched.slice(0, CAP),
        ambiguous: result.ambiguous.slice(0, CAP),
        ...(truncated ? { note: `Lists truncated to the first ${CAP}; use the admin migrate-reference endpoint for all rows.` } : {}),
      };
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
        { data: args.data as EntryData, slug: args.slug, publish: args.publish, resolveReferences: true },
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
      const patch: UpdateEntryPatch = { resolveReferences: true };
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
    description:
      "Permanently delete an entry. If it was published, it is removed from delivery immediately. " +
      "Any reference fields in OTHER entries that point at this one will resolve to null after deletion; " +
      "the result lists those referrers under `referencedBy` (computed before the delete) so nothing is silent.",
    schema: z.object({ id: z.string() }),
    handler: async (ctx, args) => {
      // Compute reverse usage BEFORE deleting — afterwards the row (and the LIKE-scan hit) is gone.
      const usage = await getEntryUsage(ctx.db, args.id);
      await deleteEntry(ctx.db, args.id);
      return {
        ok: true,
        deleted: args.id,
        referencedBy: usage.entries.map((e) => ({
          id: e.entryId,
          collection: e.collectionSlug,
          title: e.title,
        })),
      };
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

// --- Store (commerce) tools --------------------------------------------------
// Gated: these are only listed and callable when the Store module is enabled (see
// mcp/server.ts). The always-available `set_store_enabled` lives in TOOLS above.

function summarizeProduct(p: ProductDetail) {
  return {
    slug: p.slug,
    name: p.name,
    status: p.status,
    priceAmount: p.priceAmount,
    sku: p.sku,
    stock: p.stock,
    categoryId: p.categoryId,
    customData: p.customData,
    images: p.images.length,
  };
}

function summarizeCategory(c: CategoryDTO) {
  return { slug: c.slug, name: c.name, description: c.description, parentId: c.parentId };
}

/** Resolve a category slug to its internal id (the column products store). */
async function resolveCategoryId(ctx: ToolContext, slug: string): Promise<string> {
  return (await getCategory(ctx.db, slug)).id;
}

const productInputFields = {
  name: z.string().optional().describe("Display name."),
  description: z.string().nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).optional().describe("draft (default), active (served by the catalog) or archived."),
  priceAmount: z.number().int().min(0).optional().describe("Price in minor currency units (e.g. cents). Integer."),
  sku: z.string().nullable().optional().describe("Stock-keeping unit. Unique when set; null to clear."),
  stock: z.number().int().min(0).nullable().optional().describe("Units in stock; null = untracked."),
  category: z.string().nullable().optional().describe("Category slug. null to clear."),
  customData: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Custom-field values keyed by product field name (see get_product_schema)."),
  imageIds: z.array(z.string()).optional().describe("Ordered media ids (images) for the gallery. Replaces the gallery."),
};

export const STORE_TOOLS: ToolDef[] = [
  defineTool({
    name: "list_products",
    description: "List products (compact: slug, name, status, price, sku, stock). Filter by status, category slug, search; paginates.",
    schema: z.object({
      status: z.enum(["draft", "active", "archived"]).optional(),
      category: z.string().optional().describe("Filter by category slug."),
      search: z.string().optional().describe("Substring match over name and SKU."),
      limit: z.number().int().min(1).max(100).optional().describe("Default 50."),
      offset: z.number().int().min(0).optional(),
    }),
    handler: async (ctx, args) => {
      const categoryId = args.category ? await resolveCategoryId(ctx, args.category) : undefined;
      const r = await listProducts(ctx.db, {
        status: args.status as ProductStatus | undefined,
        categoryId,
        search: args.search,
        limit: args.limit,
        offset: args.offset,
      });
      return {
        total: r.total,
        products: r.products.map((p) => ({
          slug: p.slug,
          name: p.name,
          status: p.status,
          priceAmount: p.priceAmount,
          sku: p.sku,
          stock: p.stock,
          category: p.categoryName,
        })),
      };
    },
  }),

  defineTool({
    name: "get_product",
    description: "Get one product by slug, including its custom-field values and image gallery.",
    schema: z.object({ slug: z.string() }),
    handler: async (ctx, args) => {
      const p = await getProduct(ctx.db, args.slug);
      return { ...summarizeProduct(p), images: p.images.map((m) => mediaForMcp(ctx.origin, m)) };
    },
  }),

  defineTool({
    name: "create_product",
    description:
      "Create a product. priceAmount is in minor currency units. Set status:'active' to serve it from the " +
      "public catalog (this enforces required custom fields). Use get_product_schema for the custom fields.",
    schema: z.object({
      slug: z.string().describe("URL-safe slug, lowercase. Immutable-ish (changeable but breaks links)."),
      ...productInputFields,
      name: z.string().describe("Display name."),
    }),
    handler: async (ctx, args) => {
      const categoryId = typeof args.category === "string" ? await resolveCategoryId(ctx, args.category) : null;
      const p = await createProduct(
        ctx.db,
        {
          slug: args.slug,
          name: args.name,
          description: args.description ?? null,
          status: args.status as ProductStatus | undefined,
          priceAmount: args.priceAmount,
          sku: args.sku,
          stock: args.stock,
          categoryId,
          customData: args.customData as EntryData | undefined,
          imageIds: args.imageIds,
        },
        ctx.userId,
      );
      return summarizeProduct(p);
    },
  }),

  defineTool({
    name: "update_product",
    description: "Update a product by slug. Provided custom fields are merged into existing customData; imageIds (if given) replaces the gallery.",
    schema: z.object({ slug: z.string(), ...productInputFields }),
    handler: async (ctx, args) => {
      const patch: Parameters<typeof updateProduct>[2] = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined) patch.description = args.description;
      if (args.status !== undefined) patch.status = args.status as ProductStatus;
      if (args.priceAmount !== undefined) patch.priceAmount = args.priceAmount;
      if (args.sku !== undefined) patch.sku = args.sku;
      if (args.stock !== undefined) patch.stock = args.stock;
      if (args.category !== undefined) {
        patch.categoryId = typeof args.category === "string" ? await resolveCategoryId(ctx, args.category) : null;
      }
      if (args.customData !== undefined) patch.customData = args.customData as EntryData;
      if (args.imageIds !== undefined) patch.imageIds = args.imageIds;
      return summarizeProduct(await updateProduct(ctx.db, args.slug, patch, ctx.userId));
    },
  }),

  defineTool({
    name: "delete_product",
    description: "Permanently delete a product. Pass confirm equal to the slug to proceed.",
    schema: z.object({ slug: z.string(), confirm: z.string().describe("Must equal the slug.") }),
    handler: async (ctx, args) => {
      await deleteProduct(ctx.db, args.slug, args.confirm);
      return { ok: true, deleted: args.slug };
    },
  }),

  defineTool({
    name: "list_categories",
    description: "List product categories with their product counts.",
    schema: z.object({}),
    handler: async (ctx) => {
      const cats = await listCategories(ctx.db);
      return cats.map((c) => ({ slug: c.slug, name: c.name, productCount: c.productCount, parentId: c.parentId }));
    },
  }),

  defineTool({
    name: "create_category",
    description: "Create a product category. `parent` is an optional parent category slug.",
    schema: z.object({
      slug: z.string().describe("URL-safe slug, lowercase."),
      name: z.string(),
      description: z.string().nullable().optional(),
      parent: z.string().nullable().optional().describe("Parent category slug."),
    }),
    handler: async (ctx, args) => {
      const parentId = typeof args.parent === "string" ? (await getCategory(ctx.db, args.parent)).id : null;
      const c = await createCategory(ctx.db, {
        slug: args.slug,
        name: args.name,
        description: args.description ?? null,
        parentId,
      });
      return summarizeCategory(c);
    },
  }),

  defineTool({
    name: "update_category",
    description: "Update a category by slug. `parent` is a parent category slug, or null to clear.",
    schema: z.object({
      slug: z.string(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      parent: z.string().nullable().optional(),
    }),
    handler: async (ctx, args) => {
      const patch: { name?: string; description?: string | null; parentId?: string | null } = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined) patch.description = args.description;
      if (args.parent !== undefined) {
        patch.parentId = typeof args.parent === "string" ? (await getCategory(ctx.db, args.parent)).id : null;
      }
      return summarizeCategory(await updateCategory(ctx.db, args.slug, patch));
    },
  }),

  defineTool({
    name: "delete_category",
    description: "Delete a category. Products in it keep existing but lose the category. Pass confirm equal to the slug.",
    schema: z.object({ slug: z.string(), confirm: z.string().describe("Must equal the slug.") }),
    handler: async (ctx, args) => {
      await deleteCategory(ctx.db, args.slug, args.confirm);
      return { ok: true, deleted: args.slug };
    },
  }),

  defineTool({
    name: "get_product_schema",
    description: "Get the shared product custom-field schema (one field set applied to all products).",
    schema: z.object({}),
    handler: async (ctx) => {
      const fields = await getProductFields(ctx.db);
      return { fields: fields.map((f) => ({ name: f.name, label: f.label, type: f.type, options: f.options })) };
    },
  }),

  defineTool({
    name: "set_product_schema",
    description:
      "Declaratively replace the shared product field set. Diffs by field name → { added, updated, removed }. " +
      "Removing a field or changing its type discards that value across all products, so those need allowDestructive:true.",
    schema: z.object({
      fields: z.array(fieldInput).describe("The complete desired field list (order matters)."),
      allowDestructive: z.boolean().optional().describe("Required to remove fields or change a field's type."),
    }),
    handler: async (ctx, args) => {
      return setProductFields(ctx.db, { fields: toFieldInputs(args.fields), allowDestructive: args.allowDestructive });
    },
  }),
];
