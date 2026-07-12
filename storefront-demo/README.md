# Storefront demo — how to interact with the Store API

A single-file (`index.html`), dependency-free example storefront that talks to a
running Dito CMS through its **public commerce API** (`/api/commerce/*`). It shows the
end-to-end buyer flow: list the catalog → build a cart → **place a real order**.

Use it as a reference when building any storefront (Astro, Next, a mobile app, …)
against this CMS — the endpoints, payloads, and rules below are the whole public
surface. Everything here is what `index.html` actually does; open it side-by-side.

---

## Run it

You need two things running: the **CMS** (serves the API) and this **static page**.

1. **Start the CMS** (from the repo root) — it listens on `http://localhost:5173`:
   ```bash
   bun run dev
   ```
   The store must be **enabled** (Settings → General → "Enable Store", or the
   `commerce_enabled` setting) and have at least one **active** product. When the
   store is off, every `/api/commerce/*` route returns `404` by design.

2. **Serve this folder** on its own origin (any static server works):
   ```bash
   npx serve -l 4321 storefront-demo
   # → http://localhost:4321
   ```
   (There's also a `storefront` entry in `.claude/launch.json` that runs exactly this.)

3. Open **http://localhost:4321**. The page reads `API_BASE` (top of the `<script>`
   in `index.html`) to reach the CMS — point it at your deployment to test against prod.

Cross-origin is fine: the commerce API sends `Access-Control-Allow-Origin: *`, so the
`:4321` page can call the `:5173` API directly from the browser.

---

## The Store API at a glance

Base path: **`/api/commerce`**. All routes are gated by the `commerce_enabled` setting
(off → `404`). No auth — these are buyer-facing. Two flavors:

| Kind | Routes | Caching |
|---|---|---|
| **Catalog** (read) | `GET /products`, `GET /products/:slug`, `GET /categories` | `ETag` + `Cache-Control: public, max-age=60` |
| **Live commerce** | `GET /availability`, `POST /checkout`, `GET /orders/:id` | `Cache-Control: no-store` |

**Money is always integer minor units** (céntimos): `priceAmount: 7900` = S/ 79.00.
Divide by 100 for display. The store currency (default `PEN`) comes from settings and
is returned on orders.

### Catalog

```
GET /api/commerce/products?category=<slug>&search=<q>&limit=20&offset=0
```
Only **active** products. `limit` defaults to 20 (max 100). Returns:
```jsonc
{
  "data": [
    {
      "id": "…", "slug": "mouse-inalambrico", "name": "Mouse Inalámbrico Ergonómico",
      "description": null, "priceAmount": 7900, "sku": null,
      "available": true,                       // derived: stock === null || stock > 0
      "category": { "slug": "…", "name": "…" } | null,
      "images": [{ "url": "https://…", "alt": "…", "width": …, "height": … }],
      "data": { /* custom product fields, keyed by field name */ }
    }
  ],
  "meta": { "total": 2, "limit": 20, "offset": 0 }
}
```
- `GET /api/commerce/products/:slug` → `{ "data": <one product> }` (or `404`).
- `GET /api/commerce/categories` → `{ "data": [{ "slug", "name", "description", "parentSlug" }] }`.

> `available` on the cached catalog is a listing-time approximation (good for a
> "sold out" badge). For exact, moment-of-truth stock, use `/availability` below —
> raw stock **counts** are never exposed publicly.

### Live availability

```
GET /api/commerce/availability?slugs=mouse-inalambrico,teclado-mecanico
```
Up to **50** slugs per call. Always `no-store`. Returns only a boolean per slug —
unknown/draft/archived are indistinguishable (`false`):
```json
{ "availability": { "mouse-inalambrico": { "available": true }, "teclado-mecanico": { "available": true } } }
```

### Checkout — `POST /api/commerce/checkout`

Creates an order. **This is the important one.** The server **re-prices every line from
the database** — no amount, price, or currency is ever read from the request body.

**Request body** (`CheckoutInput`):
```jsonc
{
  "email": "buyer@example.com",          // REQUIRED, validated
  "items": [                              // 1..100 lines, one per product
    { "slug": "mouse-inalambrico", "quantity": 1 },
    { "slug": "teclado-mecanico",  "quantity": 1 }
  ],
  "customerName": "Cliente Demo",         // optional
  "customerPhone": "…",                   // optional
  "shippingAddress": { /* free-form */ }, // optional, stored as JSON
  "note": "…",                            // optional
  "paymentToken": "tkn_test_…"            // optional — see "Payment modes" below
}
```
- Optional **`Idempotency-Key`** header: the server hashes `key + email + body`, so the
  *same* key with the *same* payload **replays** the original order (returns it, `200`)
  instead of creating a duplicate. A different payload → a new order. For a test-order
  generator, send a **fresh key per attempt** (or omit it).
- Rate limit: **10 requests / 60s per IP** → `429` with `Retry-After`.

**Responses** — the outcome kind maps to the HTTP status; the body carries the order:
| Status | Meaning | Body |
|---|---|---|
| `201` | **pending** — no `paymentToken` sent; order created, no charge | `{ order }` |
| `201` | **paid** — `paymentToken` charged successfully | `{ order }` |
| `202` | payment outcome **unknown** (timeout/5xx); stays `awaiting_payment` | `{ order }` |
| `200` | **replay** of a prior identical `Idempotency-Key` | `{ order, error? }` |
| `400` | **validation error** — no order created | `{ error: { code, message, fieldErrors?, itemErrors? } }` |
| `402` | **payment failed** — order is terminally `failed` | `{ order, error: { code, message } }` |
| `503` | **payments unavailable** — token sent but no gateway configured | `{ error }` |
| `429` | rate limited | `{ error }` |

The **`order`** (a `CheckoutOrderDTO`) is what you show on the confirmation screen:
```jsonc
{
  "order": {
    "id": "QAMcqR91iqXtlak8G0h-0",         // needed for the status link below
    "accessToken": "7uVw3XKhFQMcHxHhqb0U3QKm", // secret; only checkout ever returns it
    "number": 6, "status": "pending",
    "items": [{ "name": "…", "quantity": 1, "unitAmount": 7900, "totalAmount": 7900 }],
    "subtotalAmount": 23800, "shippingAmount": 0, "totalAmount": 23800,
    "currency": "PEN", "createdAt": 1783836597443
  }
}
```
`itemErrors` on a `400` are per-line: `{ index, slug, code }` where `code` is
`unknown_product` or `insufficient_stock` — map them back onto the offending cart line.

### Order status (buyer's receipt)

```
GET /api/commerce/orders/:id?token=<accessToken>
```
Gated **only** by the `accessToken` from checkout. A wrong or missing token behaves
exactly like an unknown id (`404`), so the endpoint leaks nothing. The returned
`PublicOrderDTO` **omits all PII** (no email/name) — the link may be forwarded, so it
never echoes personal data. Poll it to reflect `pending → paid → fulfilled`.

---

## Payment modes

The single `paymentToken` field is the whole switch:

- **No token → `pending` order** (what this demo does). The order is created and waits
  for payment to be settled some other way (offline/manual, or a later payment attempt).
  Needs **zero** payment config — ideal for testing the order pipeline. It shows up
  immediately in the admin under **Tienda → Pedidos**.

- **With a token → real charge.** The client tokenizes the card/Yape **in the browser**
  with the gateway's **public** key (e.g. Culqi.js), then sends the resulting
  `tkn_…` / `ype_…` token here. The server charges it with the **secret** key and the
  order becomes `paid` (or `failed`). This requires the gateway to be configured and
  enabled in **Settings → Store** (currently Culqi). Token shape must match
  `^(tkn|ype|crd)_(test|live)_…`.

> This demo intentionally stops at the pending order — wiring a live (test-mode) card
> payment needs gateway keys and an in-browser tokenization script, which is a separate
> step. The pending flow already exercises catalog → cart → order → admin end-to-end.

---

## How `index.html` maps to the API

| In the page | Does |
|---|---|
| `loadProducts()` | `GET /products` → renders the grid. Reads `priceAmount`, `available`, `images[0].url`. |
| cart (`cart` object) | Pure client state; keeps the whole product so `slug` is on hand for checkout. |
| `checkout()` | Validates email, builds `items: [{slug, quantity}]`, `POST /checkout` (no token), sends a fresh `Idempotency-Key`, then branches on the response. |
| `checkoutErrorMessage()` | Turns a `400`/`429`/`503` body into a buyer message; surfaces `itemErrors` per product. |
| `showConfirmation(order)` | Renders the **real** returned `number` + `totalAmount`. |

---

## Notes & gotchas

- **Never trust client amounts** — the server re-prices from the DB. Don't send prices;
  they're ignored. Compute your cart total for display only.
- **Amounts are minor units** everywhere (request re-pricing, response, order status).
- **Email is required**; the API `400`s without a valid one (the demo also gates client-side).
- **Store off / no active products →** `/products` is `404` / returns an empty `data`.
  If the page says it can't load products, check the store is enabled and `API_BASE`.
- Keep the **`accessToken`** if you want to show the buyer their order status later; it's
  returned **only** by checkout, never echoed by the status endpoint.
