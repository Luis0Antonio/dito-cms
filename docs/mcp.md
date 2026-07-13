# Dito CMS — MCP server

Every Dito CMS deployment ships a built-in **MCP server** that lets Claude — or any
[Model Context Protocol](https://modelcontextprotocol.io) client — model your content, author
and publish entries, and pull media in from a URL. It runs the same services the admin UI uses,
so validation and publish semantics are identical.

**This page is the whole contract.** Point an agent at it (or at its
[raw URL](https://raw.githubusercontent.com/Luis0Antonio/dito-cms/main/docs/mcp.md)) and it has
everything needed to connect and drive an instance — no repository access required. Once
connected, the server describes itself live: the tool schemas come from the standard MCP
`tools/list`, and [`get_cms_info`](#first-call-get_cms_info) returns a snapshot of the specific
instance.

---

## Endpoint & transport

| | |
|---|---|
| **URL** | `POST https://<your-instance>/mcp` — e.g. `https://your-worker.workers.dev/mcp` |
| **Transport** | Stateless [Streamable HTTP](https://modelcontextprotocol.io/specification), JSON responses (no SSE, no sessions) |
| **Methods** | `POST` only. `GET`/`DELETE` → `405` |
| **Server identity** | `dito-cms` |

`<your-instance>` is the origin of a deployed Dito CMS — a `*.workers.dev` subdomain or a custom
domain. Because it is stateless, every call is a self-contained request; there is nothing to keep
alive between calls.

## Authentication

The endpoint requires an **API key** as a bearer token:

```
Authorization: Bearer dito_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- **Mint a key** in the admin UI under **Settings → API keys**. Keys are prefixed `dito_`.
- Keys are **admin-issued and not rate-limited** — they are meant for trusted callers (agents,
  delivery sites, CI). Treat them as secrets; revoking a key immediately `401`s the endpoint.
- A logged-in admin **session cookie** also authorizes the endpoint, but a bearer key is the path
  for any external client.

## Connect your client

Replace the URL with your deployment's origin and the key with your own.

**Claude Code** (native HTTP transport with custom headers):

```bash
claude mcp add --transport http dito https://your-worker.workers.dev/mcp \
  --header "Authorization: Bearer dito_xxx"
```

**Claude Desktop / clients without custom-header support** — bridge with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```bash
npx mcp-remote https://your-worker.workers.dev/mcp --header "Authorization: Bearer dito_xxx"
```

**Any client that speaks streamable HTTP** — point it at the URL and add the `Authorization`
header. A typical `mcp.json`-style entry:

```jsonc
{
  "mcpServers": {
    "dito": {
      "type": "http",
      "url": "https://your-worker.workers.dev/mcp",
      "headers": { "Authorization": "Bearer dito_xxx" }
    }
  }
}
```

## First call: `get_cms_info`

Always call **`get_cms_info`** before modelling or writing content. It returns a live snapshot of
*this* instance so an agent can start from a cold context — no guessing:

- `adminBaseUrl` and the read-only `deliveryApi` URL templates
- `counts` of collections, entries and media
- the current `collections` (slug, name, type, field/entry counts)
- the `fieldTypes` reference (what each type stores and its options)
- `store.enabled` — whether the optional commerce module is on

This is the instance's own description; the tables below are the stable capability map.

## Tools

The server exposes **18 always-on tools** plus **11 Store tools that appear only when the
commerce module is enabled** (29 total). Tool names and one-line summaries are below; the
**authoritative, always-current input schemas come from MCP `tools/list`** (and `get_cms_info`
for the field-type options). This page intentionally does not copy the schemas — connect and read
them live.

### Instance & module

| Tool | What it does |
|---|---|
| `get_cms_info` | Cold-start overview of the instance. Call first. |
| `set_store_enabled` | Enable/disable the optional Store (commerce) module. Always available. |
| `set_forms_enabled` | Enable/disable the optional Forms (contact forms) module. Always available. |

### Collections & schema

| Tool | What it does |
|---|---|
| `list_collections` | List all collections and singletons with field/entry counts. |
| `get_collection` | Get one collection or singleton by slug, with its ordered fields. |
| `create_collection` | Create a collection (many entries) or singleton (one), optionally with fields. |
| `update_collection` | Update editable metadata (name, description, title field, sort order). |
| `set_collection_fields` | Declaratively replace a collection's full field set; diffs by field name. |
| `delete_collection` | Permanently delete a collection and all its entries (`confirm` must equal the slug). |

### Entries (draft → publish)

| Tool | What it does |
|---|---|
| `list_entries` | List a collection's entries (compact) with status filter, search, pagination. |
| `get_entry` | Get one entry by id: draft data, published data, derived status. |
| `create_entry` | Create an entry; set `publish: true` to publish immediately, else save a draft. |
| `update_entry` | Merge partial field values into an entry's draft. |
| `publish_entry` | Validate against the publish schema and copy the draft to the live delivery API. |
| `unpublish_entry` | Remove an entry from delivery; the draft is kept. |
| `delete_entry` | Permanently delete an entry. |

### Media

| Tool | What it does |
|---|---|
| `list_media` | List images/videos with absolute URLs; use a returned id as a `picture`/`video` value. |
| `upload_media_from_url` | Fetch an image/video from a public URL into the library; returns its id. |

### Store — commerce (only listed when the module is enabled)

Enable with `set_store_enabled` first (or from **Settings**). These then become available:

| Group | Tools |
|---|---|
| Products | `list_products`, `get_product`, `create_product`, `update_product`, `delete_product` |
| Categories | `list_categories`, `create_category`, `update_category`, `delete_category` |
| Product schema | `get_product_schema`, `set_product_schema` |

## Content model in brief

- **Collections** hold many entries; **singletons** hold exactly one (auto-created on first
  edit/publish). `slug` and `type` are immutable after creation.
- **Fields** are one of eight types — `text`, `rich_text`, `number`, `boolean`, `picture`,
  `video`, `link`, `reference`. `get_cms_info` returns what each stores and its per-type options.
  `rich_text` accepts a plain string or a TipTap JSON doc; `picture`/`video` store a media id.
- **`reference`** links entries across collections: it stores a target entry id (or an array of
  ids when `multiple`), and you may pass a target entry **slug** instead of an id — it's resolved
  automatically. The delivery API returns references **expanded** as `{ id, slug, title, collection }`
  (a deleted/unpublished target becomes `null`). A required reference to an unpublished target is
  blocked at publish. Configure it with `targetCollections` (allowed target slugs; `[]`/`["*"]` = any)
  and `multiple`.
- **Draft → publish.** Edits save as drafts; the delivery API serves only the last published
  version. Required fields and bounds are enforced at publish time, not while drafting.
- **Destructive changes are guarded.** Removing a field or changing its type needs
  `allowDestructive: true`; deleting a collection/entry/product needs `confirm` to equal the slug.
- **Tool errors don't throw.** Validation and service errors come back as readable, non-throwing
  tool results (with field-level detail) an agent can act on.

## A typical session

1. `get_cms_info` — learn the instance's URLs, existing collections and field types.
2. `create_collection` — e.g. a `hero` singleton and a `features` collection, with their fields.
3. `upload_media_from_url` — pull in an image, keep the returned id.
4. `create_entry` with `publish: true` — author content, using the media id for `picture` fields.
5. Read it back from the public **delivery API** to confirm it's live.

## Reading published content (delivery API)

The MCP server writes content; sites read it from the **public, read-only, CORS-open** delivery
API — no key required:

```
GET https://<your-instance>/api/v1/collections            # schema (collections + fields)
GET https://<your-instance>/api/v1/content/:slug          # collection list, or a singleton
GET https://<your-instance>/api/v1/content/:slug/:idOrSlug # one published entry by id or slug
```

See the [README](../README.md#reading-content-delivery-api) for filtering, caching and a frontend
example.
