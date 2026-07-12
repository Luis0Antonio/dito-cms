import { and, asc, count, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";

import type { DrizzleDb } from "../../db/client";
import {
  orderItems,
  orders,
  payments,
  type OrderItemRow,
  type OrderRow,
  type PaymentRow,
} from "../../db/schema";
import { conflict, notFound } from "../../lib/errors";

import type {
  AdminOrderDetail,
  AdminOrderItem,
  AdminOrderSummary,
  AdminPayment,
  CheckoutOrderDTO,
  ListOrdersParams,
  OrderListResult,
  PublicOrderDTO,
  PublicOrderItem,
} from "@/shared/api-types";

// Orders: admin listing/detail, the buyer-facing (token-gated) public view, and the two
// merchant transitions (fulfill, cancel). Orders are immutable financial records — nothing
// here edits amounts or items; only status walks forward. Both transitions are GUARDED
// UPDATEs (the WHERE clause carries the state check), never read-then-write, so a concurrent
// transition can never double-apply or pull an order out of a terminal state. The paid
// transition lives in ./paid-transition.ts; checkout in ./checkout.ts.

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

// --- mapping -----------------------------------------------------------------

/** Parse a JSON text column defensively; null/garbage → null. */
function parseJsonOrNull(text: string | null): unknown {
  if (text === null || text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toPublicOrderItem(row: OrderItemRow): PublicOrderItem {
  return {
    name: row.name,
    quantity: row.quantity,
    unitAmount: row.unitAmount,
    totalAmount: row.totalAmount,
  };
}

/** Buyer-facing view. Deliberately NO email/customer fields — the token link may leak. */
export function toPublicOrderDTO(order: OrderRow, items: OrderItemRow[]): PublicOrderDTO {
  return {
    number: order.number,
    status: order.status,
    items: items.map(toPublicOrderItem),
    subtotalAmount: order.subtotalAmount,
    shippingAmount: order.shippingAmount,
    totalAmount: order.totalAmount,
    currency: order.currency,
    createdAt: order.createdAt,
  };
}

/** Checkout-response view: the public DTO plus id + accessToken for the status link. */
export function toCheckoutOrderDTO(order: OrderRow, items: OrderItemRow[]): CheckoutOrderDTO {
  return { ...toPublicOrderDTO(order, items), id: order.id, accessToken: order.accessToken };
}

function toAdminOrderItem(row: OrderItemRow): AdminOrderItem {
  return {
    id: row.id,
    productId: row.productId,
    name: row.name,
    sku: row.sku,
    quantity: row.quantity,
    unitAmount: row.unitAmount,
    totalAmount: row.totalAmount,
    imageMediaId: row.imageMediaId,
  };
}

function toAdminPayment(row: PaymentRow): AdminPayment {
  return {
    id: row.id,
    provider: row.provider,
    providerRef: row.providerRef,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    // `raw` was stored as driver-redacted JSON (scalars only); parse for the admin UI.
    raw: parseJsonOrNull(row.raw),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAdminOrderSummary(row: OrderRow): AdminOrderSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    email: row.email,
    customerName: row.customerName,
    currency: row.currency,
    totalAmount: row.totalAmount,
    stockConflict: row.stockConflict !== 0,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
  };
}

// --- loaders -----------------------------------------------------------------

/** All items of one order. Exported for checkout.ts and order-hook.ts (one order at a time). */
export async function loadOrderItems(db: DrizzleDb, orderId: string): Promise<OrderItemRow[]> {
  return db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id))
    .all();
}

async function findOrderRow(db: DrizzleDb, orderId: string): Promise<OrderRow> {
  const row = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!row) throw notFound("Order not found");
  return row;
}

// --- admin queries -----------------------------------------------------------

/**
 * Admin order list. Ordered by lifecycle stage so the orders that need attention float to the
 * top — open stages first (pending, awaiting_payment, paid), then terminal ones — and newest
 * first within each stage. `search` matches an exact order number (`42` / `#42`) or an email —
 * case-insensitive exact match, or prefix — since admins paste whole addresses.
 */
export async function listOrders(db: DrizzleDb, params: ListOrdersParams): Promise<OrderListResult> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);

  const conds: SQL[] = [];
  if (params.status) conds.push(eq(orders.status, params.status));
  const term = params.search?.trim();
  if (term) {
    const num = /^#?(\d{1,12})$/.exec(term);
    if (num) {
      conds.push(eq(orders.number, Number(num[1])));
    } else {
      conds.push(
        or(sql`lower(${orders.email}) = lower(${term})`, like(orders.email, `${term}%`)) as SQL,
      );
    }
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  // Lifecycle-stage ordering: open/actionable stages first, terminal ones last. Within a stage,
  // newest first. (A status filter collapses this to a single stage, leaving the date order.)
  const stageRank = sql`case ${orders.status}
    when 'pending' then 0
    when 'awaiting_payment' then 1
    when 'paid' then 2
    when 'fulfilled' then 3
    when 'cancelled' then 4
    when 'refunded' then 5
    when 'failed' then 6
    else 7 end`;

  const totalRow = await db.select({ n: count() }).from(orders).where(where).get();
  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(stageRank, desc(orders.createdAt), desc(orders.number))
    .limit(limit)
    .offset(offset)
    .all();

  return { orders: rows.map(toAdminOrderSummary), total: totalRow?.n ?? 0 };
}

/** Full admin view: order + items + payment attempts (payments oldest-first). */
export async function getOrderDetail(db: DrizzleDb, orderId: string): Promise<AdminOrderDetail> {
  const row = await findOrderRow(db, orderId);
  const [items, paymentRows] = await Promise.all([
    loadOrderItems(db, orderId),
    db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(asc(payments.createdAt))
      .all(),
  ]);
  return {
    id: row.id,
    number: row.number,
    accessToken: row.accessToken,
    status: row.status,
    email: row.email,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    shippingAddress: parseJsonOrNull(row.shippingAddress),
    note: row.note,
    currency: row.currency,
    subtotalAmount: row.subtotalAmount,
    shippingAmount: row.shippingAmount,
    totalAmount: row.totalAmount,
    stockConflict: row.stockConflict !== 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    paidAt: row.paidAt,
    fulfilledAt: row.fulfilledAt,
    cancelledAt: row.cancelledAt,
    items: items.map(toAdminOrderItem),
    payments: paymentRows.map(toAdminPayment),
  };
}

// --- public (buyer) view -----------------------------------------------------

/**
 * Compare two strings in time independent of WHERE they differ (constant-time-ish). Both a
 * missing order and a wrong token surface as the same not_found so the endpoint leaks nothing.
 * Length is not hidden — access tokens are a fixed public length (nanoid 24).
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * The buyer's order-status view, gated by the unguessable accessToken from checkout.
 * Wrong token and unknown id are indistinguishable (both 404). Limited DTO — no PII echo.
 */
export async function getPublicOrder(
  db: DrizzleDb,
  orderId: string,
  accessToken: string,
): Promise<PublicOrderDTO> {
  const row = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!row || !timingSafeEqualStr(row.accessToken, accessToken)) {
    throw notFound("Order not found");
  }
  return toPublicOrderDTO(row, await loadOrderItems(db, orderId));
}

// --- transitions -------------------------------------------------------------

/**
 * paid → fulfilled. Guarded UPDATE: the status check rides in the WHERE, so two concurrent
 * fulfills apply exactly once and nothing can fulfill an unpaid/terminal order.
 */
export async function fulfillOrder(db: DrizzleDb, orderId: string): Promise<AdminOrderDetail> {
  const now = Date.now();
  const updated = await db
    .update(orders)
    .set({ status: "fulfilled", fulfilledAt: now, updatedAt: now })
    .where(and(eq(orders.id, orderId), eq(orders.status, "paid")))
    .returning({ id: orders.id });
  if (updated.length === 0) {
    const row = await findOrderRow(db, orderId); // throws notFound when missing
    throw conflict(`Only paid orders can be fulfilled (order is ${row.status})`, {
      status: "Order must be paid",
    });
  }
  return getOrderDetail(db, orderId);
}

/**
 * pending/awaiting_payment → cancelled. Paid orders are NOT cancellable here — money moved,
 * so undoing them means a refund (phase 3). There is no stock to release: stock only ever
 * decrements on the paid transition, and unpaid orders hold none. Guarded UPDATE as above;
 * the guard also means a cancel can never race the paid transition into an inconsistent
 * state — whichever guarded UPDATE lands first wins, the loser changes 0 rows.
 */
export async function cancelOrder(db: DrizzleDb, orderId: string): Promise<AdminOrderDetail> {
  const now = Date.now();
  const updated = await db
    .update(orders)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(and(eq(orders.id, orderId), inArray(orders.status, ["pending", "awaiting_payment"])))
    .returning({ id: orders.id });
  if (updated.length === 0) {
    const row = await findOrderRow(db, orderId); // throws notFound when missing
    throw conflict(`Only pending or awaiting-payment orders can be cancelled (order is ${row.status})`, {
      status: "Order can no longer be cancelled",
    });
  }
  return getOrderDetail(db, orderId);
}
