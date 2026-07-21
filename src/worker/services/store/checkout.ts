import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import type { DrizzleDb } from "../../db/client";
import {
  counters,
  orderItems,
  orders,
  payments,
  productImages,
  products,
  type OrderItemRow,
  type OrderRow,
  type ProductRow,
} from "../../db/schema";
import { getCulqiConfig, getStoreCurrency, type CulqiRuntimeConfig } from "./settings";
import {
  getPaymentProvider,
  ChargeUnknownError,
  type ChargeResult,
  type PaymentProvider,
} from "./payments/types";
import { applyPaidTransition } from "./paid-transition";
import { loadOrderItems, toCheckoutOrderDTO } from "./orders";

import { D1_IN_CHUNK } from "@/shared/constants";
import type {
  CheckoutInput,
  CheckoutItemError,
  CheckoutOrderDTO,
  CheckoutResult,
} from "@/shared/api-types";

// Checkout — the write path where money starts moving. Every EXPECTED outcome is a RETURNED
// {@link CheckoutResult} kind (the route maps kinds to HTTP statuses); only genuine bugs and
// infrastructure failures throw. Hard rules enforced here:
//   - Currency comes from settings, prices come from the products table. NOTHING amount-like
//     is ever read from the client.
//   - The payments INTENT row is written (with the order set awaiting_payment) BEFORE the
//     charge call, so a crash mid-charge leaves a webhook-recoverable trail: Culqi charges
//     carry metadata.orderId, and the 2E webhook path can complete the paid transition.
//   - A DEFINITIVE decline marks the order `failed` — terminal. A buyer retry is a brand-new
//     checkout; unpaid orders hold no stock, so nothing needs releasing.
//   - An UNKNOWN charge outcome (ChargeUnknownError) leaves the order `awaiting_payment` and
//     the payment row `created`. NEVER failed — money may have moved.
// Rate limiting and Idempotency-Key hashing live at the route layer; this service receives an
// already-hashed `idempotencyKeyHash`. NOTE: there is NO bot/abuse challenge (Turnstile,
// CAPTCHA) anywhere in the stack — deliberately, since it needs per-deployment keys and
// storefront-side markup this CMS can't provide generically. The only guard on guest checkout
// is the per-IP window in routes/commerce.ts (10/min), which an IP-rotating card-testing ring
// can walk around. A deployment putting a live payment account behind this should add a
// challenge at its own edge (or in front of the storefront's checkout form).

/** The only payment provider in v1. The registry makes phase-3 providers a key swap. */
const PROVIDER = "culqi";

const MAX_ITEMS = 100;
const MAX_QUANTITY = 999;
const MAX_EMAIL_LEN = 254;
const MAX_NAME_LEN = 200;
const MAX_PHONE_LEN = 50;
const MAX_NOTE_LEN = 2000;
const MAX_SLUG_LEN = 200;
const MAX_TOKEN_LEN = 200;
const MAX_ADDRESS_JSON_LEN = 4096;
/** Culqi charge bounds in céntimos (verified against their API spec): 100 ≤ amount ≤ 999900. */
const CULQI_MIN_AMOUNT = 100;
const CULQI_MAX_AMOUNT = 999_900;
/** Pragmatic email shape check — deliverability is the buyer's problem, not a parser's. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Buyer-safe fallback when a driver result somehow lacks a message. Spanish to match the
 * driver's buyer-facing messages (which are used verbatim and never re-localized).
 */
const FALLBACK_DECLINE_MESSAGE = "No pudimos procesar el pago. Intenta nuevamente.";

/** Service-level input: the wire body plus the route-computed idempotency hash (2E). */
export interface CreateCheckoutInput extends CheckoutInput {
  /** hash(Idempotency-Key + email + payload); the same triple replays the same order. */
  idempotencyKeyHash?: string;
}

type ValidationFailure = Extract<CheckoutResult, { kind: "validation_error" }>;

/** An accepted, re-priced line: the live product row + the requested quantity. */
interface PricedLine {
  product: ProductRow;
  quantity: number;
}

/**
 * Create an order from a checkout request and (when a token is present) charge it.
 * See the module comment for the money-safety rules; see {@link CheckoutResult} in
 * shared/api-types.ts for the kind → HTTP mapping the route applies.
 */
export async function createCheckout(
  db: DrizzleDb,
  env: Env,
  input: CreateCheckoutInput,
): Promise<CheckoutResult> {
  // --- 1. Structural validation ----------------------------------------------
  // Deterministic on the payload alone, so running it BEFORE the replay lookup is safe: an
  // identical replayed payload validates identically. State-dependent checks (product
  // existence, stock) run AFTER the replay lookup — otherwise a product deactivated after
  // the original purchase would break replays of it.
  const invalid = validateInput(input);
  if (invalid) return invalid;

  const email = input.email.trim();
  const paymentToken = input.paymentToken?.trim() || undefined;

  // --- 2. Idempotency replay ---------------------------------------------------
  if (input.idempotencyKeyHash) {
    const existing = await db
      .select()
      .from(orders)
      .where(eq(orders.idempotencyKey, input.idempotencyKeyHash))
      .get();
    if (existing) return buildReplay(db, existing);
  }

  // --- 3. Load + re-price from the DB ------------------------------------------
  // Currency from settings, unit prices from products — client amounts do not exist here.
  const currency = await getStoreCurrency(db);
  const { lines, itemErrors } = await priceLines(db, input.items);
  if (itemErrors.length > 0) {
    return {
      kind: "validation_error",
      message: "Some items are unavailable",
      itemErrors,
    };
  }

  const subtotalAmount = lines.reduce((sum, l) => sum + l.product.priceAmount * l.quantity, 0);
  const shippingAmount = 0; // v1: no shipping calculation.
  const totalAmount = subtotalAmount + shippingAmount;

  if (paymentToken && (totalAmount < CULQI_MIN_AMOUNT || totalAmount > CULQI_MAX_AMOUNT)) {
    return {
      kind: "validation_error",
      message:
        totalAmount < CULQI_MIN_AMOUNT
          ? `Card payments require a total of at least ${CULQI_MIN_AMOUNT} minor units`
          : `Card payments allow a total of at most ${CULQI_MAX_AMOUNT} minor units`,
      fieldErrors: { items: "Order total is outside the payable range" },
    };
  }

  // --- 4. Resolve the gateway BEFORE creating anything (when a token was sent) --
  // Deliberately earlier than the brief's step order: if payments are unavailable there is
  // no charge to recover, so creating the order first would only strand an orphaned pending
  // row the buyer can never pay. Checked after the replay lookup so old orders still replay
  // even if the gateway was later disabled.
  let chargeSetup: { cfg: CulqiRuntimeConfig; provider: PaymentProvider } | null = null;
  if (paymentToken) {
    const cfg = await getCulqiConfig(db, env);
    const provider = getPaymentProvider(PROVIDER);
    if (!cfg || !cfg.enabled || !provider) return { kind: "payments_unavailable" };
    chargeSetup = { cfg, provider };
  }

  // --- 5. Allocate the order number ---------------------------------------------
  // Atomic increment; D1 supports RETURNING. A crash after this point (or a lost idempotency
  // race below) abandons the allocated value — a GAP in order numbers, which is acceptable:
  // numbers are unique and monotonic, not gapless.
  const allocated = await db
    .update(counters)
    .set({ value: sql`${counters.value} + 1` })
    .where(eq(counters.name, "order_number"))
    .returning({ value: counters.value });
  if (allocated.length === 0) {
    // Seeded by migration 0007 — missing means the DB is not migrated. A real bug: throw.
    throw new Error("order_number counter row is missing (run migrations)");
  }
  const number = allocated[0].value;

  // --- 6. Insert order (pending) + item snapshots in ONE atomic batch -----------
  const now = Date.now();
  const orderId = nanoid();
  const primaryImages = await loadPrimaryImageIds(db, lines.map((l) => l.product.id));

  const orderRow: OrderRow = {
    id: orderId,
    number,
    accessToken: nanoid(24), // unguessable status-link secret (schema contract)
    status: "pending",
    email,
    customerName: normalizeOptional(input.customerName),
    customerPhone: normalizeOptional(input.customerPhone),
    shippingAddress: input.shippingAddress ? JSON.stringify(input.shippingAddress) : null,
    note: normalizeOptional(input.note),
    currency,
    subtotalAmount,
    shippingAmount,
    totalAmount,
    stockConflict: 0,
    idempotencyKey: input.idempotencyKeyHash ?? null,
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    fulfilledAt: null,
    cancelledAt: null,
  };
  // Frozen snapshots: name/sku/unitAmount/image survive any later product edit or deletion.
  const itemRows: OrderItemRow[] = lines.map((l) => ({
    id: nanoid(),
    orderId,
    productId: l.product.id,
    name: l.product.name,
    sku: l.product.sku,
    unitAmount: l.product.priceAmount,
    quantity: l.quantity,
    totalAmount: l.product.priceAmount * l.quantity,
    imageMediaId: primaryImages.get(l.product.id) ?? null,
  }));

  try {
    const statements: BatchItem<"sqlite">[] = [
      db.insert(orders).values(orderRow),
      ...itemRows.map((row) => db.insert(orderItems).values(row)),
    ];
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (err) {
    // Concurrent same-key checkout: the unique index on idempotencyKey made the other request
    // win. Return ITS order as a replay (our allocated number becomes a gap).
    if (input.idempotencyKeyHash && isIdempotencyConflict(err)) {
      const winner = await db
        .select()
        .from(orders)
        .where(eq(orders.idempotencyKey, input.idempotencyKeyHash))
        .get();
      if (winner) return buildReplay(db, winner);
    }
    throw err;
  }

  // --- 7. No token → the order stays pending ------------------------------------
  if (!paymentToken || !chargeSetup) {
    return { kind: "pending", order: toCheckoutOrderDTO(orderRow, itemRows) };
  }

  // --- 8. Charge path -------------------------------------------------------------
  // Intent BEFORE charge, atomically: order → awaiting_payment + the payments intent row.
  // If we crash during the charge, the intent row + Culqi's metadata.orderId let the webhook
  // path finish (or fail) the payment later.
  const intentAt = Date.now();
  const paymentId = nanoid();
  await db.batch([
    db
      .update(orders)
      .set({ status: "awaiting_payment", updatedAt: intentAt })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending"))),
    db.insert(payments).values({
      id: paymentId,
      orderId,
      provider: PROVIDER,
      providerRef: null,
      status: "created",
      amount: totalAmount,
      currency,
      errorCode: null,
      errorMessage: null,
      raw: null,
      createdAt: intentAt,
      updatedAt: intentAt,
    }),
  ]);

  let charge: ChargeResult;
  try {
    charge = await chargeSetup.provider.charge(chargeSetup.cfg, {
      order: { id: orderId, number, totalAmount, currency, email },
      token: paymentToken,
    });
  } catch (err) {
    if (err instanceof ChargeUnknownError) {
      // UNKNOWN outcome — money may have moved. The order STAYS awaiting_payment and the
      // intent row STAYS `created`; the webhook / reconciliation resolves it. NEVER failed.
      if (err.providerRef) {
        // Best-effort breadcrumb for reconciliation; guarded so a webhook that resolved the
        // payment meanwhile is never clobbered. Never fail the response over it.
        try {
          await db
            .update(payments)
            .set({ providerRef: err.providerRef, updatedAt: Date.now() })
            .where(and(eq(payments.id, paymentId), eq(payments.status, "created")))
            .run();
        } catch {
          /* the ref is a convenience, not a correctness requirement */
        }
      }
      const state = await readOrderState(db, orderId, itemRows);
      // If a concurrent webhook resolved the charge to paid while we handled the unknown,
      // the truthful answer is paid (transitioned=false: the webhook path fired the hook).
      if (state.paid) return { kind: "paid", order: state.order, transitioned: false };
      return { kind: "payment_pending", order: state.order };
    }
    // Not a charge outcome — a genuine bug/infra failure. The order stays awaiting_payment
    // (webhook-recoverable); let the global handler surface a 500.
    throw err;
  }

  switch (charge.status) {
    case "paid": {
      const { transitioned } = await applyPaidTransition(db, {
        orderId,
        provider: PROVIDER,
        providerRef: charge.providerRef,
        raw: charge.raw,
      });
      const state = await readOrderState(db, orderId, itemRows);
      // transitioned=false with a paid re-read = a concurrent webhook completed the payment
      // first; 2E's webhook path fired the hook, so the route must not fire it again.
      if (state.paid) return { kind: "paid", order: state.order, transitioned };
      // The gateway said paid but the guarded transition was refused and the order is not
      // paid: a concurrent cancel won (terminal states never revert). Answer
      // payment_pending — the payment row + payment_events keep the gateway truth for
      // reconciliation (refunds are phase 3).
      return { kind: "payment_pending", order: state.order };
    }
    case "failed":
    case "requires_action": {
      // DEFINITIVE decline (requires_action = 3DS, descoped in v1: the charge was never
      // captured, so it is surfaced as a failed attempt with the driver's explanation).
      // One guarded batch: the order exits to terminal `failed` only from a non-terminal
      // state, and the payment row records the decline only while still `created` — a
      // concurrent webhook-paid can never be overwritten (order never leaves terminal).
      const failedAt = Date.now();
      const error = {
        code: charge.errorCode ?? "payment_failed",
        message: charge.errorMessage ?? FALLBACK_DECLINE_MESSAGE,
      };
      await db.batch([
        db
          .update(orders)
          .set({ status: "failed", updatedAt: failedAt })
          .where(
            and(eq(orders.id, orderId), inArray(orders.status, ["pending", "awaiting_payment"])),
          ),
        db
          .update(payments)
          .set({
            status: "failed",
            providerRef: charge.providerRef ?? null,
            errorCode: error.code,
            errorMessage: error.message,
            raw: serializeRaw(charge.raw),
            updatedAt: failedAt,
          })
          .where(and(eq(payments.id, paymentId), eq(payments.status, "created"))),
      ]);
      const state = await readOrderState(db, orderId, itemRows);
      // A decline racing a webhook-paid is contradictory (one charge, one outcome), but the
      // guards make it harmless: if the re-read says paid, the paid state won — report it.
      if (state.paid) return { kind: "paid", order: state.order, transitioned: false };
      return { kind: "payment_failed", order: state.order, error };
    }
    default:
      return assertNever(charge.status);
  }
}

// --- helpers -------------------------------------------------------------------

function assertNever(value: never): never {
  throw new Error(`Unhandled charge status: ${String(value)}`);
}

function normalizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** JSON-encode a redacted raw snapshot; undefined/unencodable → null. */
function serializeRaw(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  try {
    const s = JSON.stringify(raw);
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
}

/**
 * Structural validation of the wire payload. Runtime `typeof` guards on top of the static
 * types because the body arrived as untrusted JSON. Returns the validation_error result, or
 * null when the input is well-formed.
 */
function validateInput(input: CreateCheckoutInput): ValidationFailure | null {
  const fieldErrors: Record<string, string> = {};

  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    fieldErrors.email = "Enter a valid email";
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    fieldErrors.items = "Add at least one item";
  } else if (input.items.length > MAX_ITEMS) {
    fieldErrors.items = `At most ${MAX_ITEMS} lines per order`;
  } else {
    const seen = new Set<string>();
    input.items.forEach((item, i) => {
      const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
      if (!slug || slug.length > MAX_SLUG_LEN) {
        fieldErrors[`items.${i}.slug`] = "Invalid product";
      } else if (seen.has(slug)) {
        // One line per product: merged quantities keep the snapshot/decrement logic 1:1.
        fieldErrors[`items.${i}.slug`] = "Duplicate product; merge quantities into one line";
      } else {
        seen.add(slug);
      }
      if (
        typeof item?.quantity !== "number" ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > MAX_QUANTITY
      ) {
        fieldErrors[`items.${i}.quantity`] = `Quantity must be a whole number 1–${MAX_QUANTITY}`;
      }
    });
  }

  checkOptionalString(fieldErrors, "customerName", input.customerName, MAX_NAME_LEN);
  checkOptionalString(fieldErrors, "customerPhone", input.customerPhone, MAX_PHONE_LEN);
  checkOptionalString(fieldErrors, "note", input.note, MAX_NOTE_LEN);
  checkOptionalString(fieldErrors, "paymentToken", input.paymentToken, MAX_TOKEN_LEN);

  if (input.shippingAddress !== undefined) {
    const addr: unknown = input.shippingAddress;
    if (typeof addr !== "object" || addr === null || Array.isArray(addr)) {
      fieldErrors.shippingAddress = "Must be an object";
    } else {
      try {
        if (JSON.stringify(addr).length > MAX_ADDRESS_JSON_LEN) {
          fieldErrors.shippingAddress = "Address is too large";
        }
      } catch {
        fieldErrors.shippingAddress = "Must be a plain JSON object";
      }
    }
  }

  if (Object.keys(fieldErrors).length === 0) return null;
  return { kind: "validation_error", message: "Invalid checkout request", fieldErrors };
}

function checkOptionalString(
  fieldErrors: Record<string, string>,
  key: string,
  value: unknown,
  maxLen: number,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > maxLen) {
    fieldErrors[key] = `Must be a string of at most ${maxLen} characters`;
  }
}

/**
 * Re-price every line from the DB. Only `active` products are purchasable; unknown and
 * inactive slugs are indistinguishable (`unknown_product`) so drafts are not enumerable.
 * The stock check here is the buyer-facing UX gate; the guarded decrement inside the paid
 * transition is the actual overselling guard.
 */
async function priceLines(
  db: DrizzleDb,
  items: CheckoutInput["items"],
): Promise<{ lines: PricedLine[]; itemErrors: CheckoutItemError[] }> {
  const slugs = items.map((i) => i.slug.trim());
  const bySlug = new Map<string, ProductRow>();
  for (let i = 0; i < slugs.length; i += D1_IN_CHUNK) {
    const chunk = slugs.slice(i, i + D1_IN_CHUNK);
    const rows = await db
      .select()
      .from(products)
      .where(and(inArray(products.slug, chunk), eq(products.status, "active")))
      .all();
    for (const row of rows) bySlug.set(row.slug, row);
  }

  const lines: PricedLine[] = [];
  const itemErrors: CheckoutItemError[] = [];
  items.forEach((item, index) => {
    const slug = item.slug.trim();
    const product = bySlug.get(slug);
    if (!product) {
      itemErrors.push({ index, slug, code: "unknown_product" });
      return;
    }
    if (product.stock !== null && item.quantity > product.stock) {
      itemErrors.push({ index, slug, code: "insufficient_stock" });
      return;
    }
    lines.push({ product, quantity: item.quantity });
  });
  return { lines, itemErrors };
}

/** productId → first gallery image (lowest sortOrder), for the order-item snapshot. */
async function loadPrimaryImageIds(db: DrizzleDb, productIds: string[]): Promise<Map<string, string>> {
  const primary = new Map<string, string>();
  for (let i = 0; i < productIds.length; i += D1_IN_CHUNK) {
    const chunk = productIds.slice(i, i + D1_IN_CHUNK);
    const rows = await db
      .select({ productId: productImages.productId, mediaId: productImages.mediaId })
      .from(productImages)
      .where(inArray(productImages.productId, chunk))
      .orderBy(asc(productImages.productId), asc(productImages.sortOrder))
      .all();
    for (const row of rows) {
      if (!primary.has(row.productId)) primary.set(row.productId, row.mediaId);
    }
  }
  return primary;
}

/** True when a batch failure was the orders.idempotency_key unique index (a same-key race). */
function isIdempotencyConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique/i.test(message) && message.includes("idempotency_key");
}

/**
 * Build the replay result for an order that this idempotency key already created. The route
 * (2E) answers 200 with the SAME body shape as the original outcome, derived from
 * `order.status`; for failed orders the original decline is attached so that shape is
 * reconstructible without extra queries.
 */
async function buildReplay(db: DrizzleDb, row: OrderRow): Promise<CheckoutResult> {
  const items = await loadOrderItems(db, row.id);
  const order = toCheckoutOrderDTO(row, items);
  if (row.status === "failed") {
    const failed = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, row.id), eq(payments.status, "failed")))
      .orderBy(desc(payments.createdAt))
      .limit(1)
      .get();
    if (failed) {
      return {
        kind: "replay",
        order,
        error: {
          code: failed.errorCode ?? "payment_failed",
          message: failed.errorMessage ?? FALLBACK_DECLINE_MESSAGE,
        },
      };
    }
  }
  return { kind: "replay", order };
}

/**
 * Re-read the order after a charge outcome was recorded, so the response reflects the
 * CURRENT state rather than what this code path assumed — the sync path and the webhook
 * path (2E) can genuinely interleave. Items are immutable snapshots, so the in-memory rows
 * are reused instead of re-queried.
 */
async function readOrderState(
  db: DrizzleDb,
  orderId: string,
  itemRows: OrderItemRow[],
): Promise<{ paid: boolean; order: CheckoutOrderDTO }> {
  const row = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!row) throw new Error("Checkout order vanished mid-request"); // impossible: created above
  return {
    paid: row.status === "paid" || row.status === "fulfilled",
    order: toCheckoutOrderDTO(row, itemRows),
  };
}
