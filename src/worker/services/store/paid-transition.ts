import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import type { DrizzleDb } from "../../db/client";
import { orderItems, orders, payments, products, type OrderItemRow } from "../../db/schema";

import { D1_IN_CHUNK } from "@/shared/constants";

// The PAID transition — the single choke point through which an order becomes `paid`, used by
// BOTH the synchronous charge path (checkout.ts) and the webhook route (2E). Those two paths
// genuinely race: Culqi fires `charge.creation.succeeded` webhooks immediately, so a webhook
// can land while the sync charge response is still in flight. Everything below is structured
// around three invariants:
//
//   I1. Stock is never decremented twice for one order.
//   I2. An order never leaves a terminal state (paid/fulfilled/cancelled/failed/refunded stay put).
//   I3. A lost race never leaves stock decremented by the loser.
//
// Chosen structure (read → one guarded batch with RETURNING → compensate/flag):
//
//   1. READ phase: load the order; if its status is already outside (pending, awaiting_payment),
//      return { transitioned: false } WITHOUT running any batch — the common idempotent-replay
//      path (webhook redelivery, sync-after-webhook) executes zero writes, so it cannot touch
//      stock (I1) or the order (I2). Also read items, the items' products' stock tracked-ness,
//      and the existing payment row for (order, provider).
//
//   2. BATCH phase (one atomic `db.batch` — D1 runs it as a transaction and rolls back on error):
//        (a) UPDATE orders SET status='paid' … WHERE id=? AND status IN ('pending','awaiting_payment')
//            RETURNING id — the guard is the race safety net; RETURNING tells us if we won.
//        (b) the payment upsert (update the existing (order, provider) row → 'paid', else insert).
//        (c) one guarded decrement per TRACKED item (stock IS NOT NULL at read time):
//            UPDATE products SET stock = stock - qty
//              WHERE id=? AND stock IS NOT NULL AND stock >= qty RETURNING id
//            Untracked items (stock NULL, or the product already deleted at read time) get NO
//            statement. RETURNING tells us per-item whether the decrement applied.
//
//   3. RACE HANDLING: if the read said "transitionable" but (a) still changed 0 rows, a
//      concurrent transition committed between our read and our batch and OUR decrements in the
//      same batch DID run (a 0-row UPDATE does not abort a D1 batch). We then run a compensating
//      batch that re-increments EXACTLY the decrements whose RETURNING proved they applied, and
//      return { transitioned: false } (satisfying I1/I3). This compensation was chosen over the
//      alternatives because it relies only on facts the batch itself reported: no timestamp
//      correlation (which collides at ms resolution) and no accept-the-window shortcut. Residual
//      window: a crash BETWEEN the batch and the compensation leaves stock over-decremented by
//      one order's quantities — inventory drift only (conservative: the store may undersell,
//      never oversell), no money/state error, merchant-correctable. Accepted and documented.
//
//   4. CONFLICT FLAG: if we DID transition but some tracked item's decrement changed 0 rows
//      (stock ran out between checkout and payment, or the product vanished after the read),
//      set orders.stockConflict = 1 in a follow-up UPDATE. The order STAYS paid — money moved;
//      the merchant resolves. (A crash before this follow-up loses only the flag, not money.)
//
// The caller fires the order hook EXACTLY once: iff the returned `transitioned` is true.

export interface PaidTransitionInput {
  orderId: string;
  /** Payment driver key, e.g. `culqi`. */
  provider: string;
  /** Gateway charge id, when known. */
  providerRef?: string;
  /** REDACTED gateway snapshot (already redacted by the driver); stored on the payment row. */
  raw?: unknown;
}

export interface PaidTransitionResult {
  /** True iff THIS call moved the order to paid — the caller's cue to fire the order hook. */
  transitioned: boolean;
}

/** Index of the first decrement statement in the batch: [orderUpdate, paymentUpsert, ...decrements]. */
const DECREMENTS_BASE = 2;

/** JSON-encode the redacted raw snapshot for the TEXT column; undefined/unencodable → null. */
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
 * Idempotently move an order to `paid`, upsert its payment row, and decrement tracked stock.
 * Safe to call from concurrent paths (sync charge + webhook); see the module comment for the
 * exact concurrency structure. Returns { transitioned: false } for unknown orders, orders
 * already paid/terminal, and lost races — callers must fire the order hook only on true.
 */
export async function applyPaidTransition(
  db: DrizzleDb,
  input: PaidTransitionInput,
): Promise<PaidTransitionResult> {
  const { orderId, provider } = input;

  // --- 1. READ phase ---------------------------------------------------------
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return { transitioned: false };
  if (order.status !== "pending" && order.status !== "awaiting_payment") {
    // Already paid or terminal: the idempotent no-op path. No batch runs, so nothing can
    // decrement stock (I1) or move the order (I2). This covers webhook redelivery and the
    // sync path arriving after a webhook already completed the payment.
    return { transitioned: false };
  }

  const items = await loadOrderItems(db, orderId);

  // Tracked-ness AT READ TIME: an item participates in stock only when it still references a
  // product whose stock is NOT NULL right now. Items whose product was deleted (productId set
  // null by FK) or is untracked get no decrement statement — and therefore can never flag a
  // conflict; only a read-said-tracked item whose guarded decrement misses does.
  const trackedStock = await loadTrackedStock(db, items);
  const trackedItems = items.filter(
    (i): i is OrderItemRow & { productId: string } =>
      i.productId !== null && trackedStock.has(i.productId),
  );

  // The existing payment row for (order, provider): normally the intent row checkout wrote
  // before charging. The webhook path may arrive with none (crash before the intent batch).
  const intent = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.provider, provider)))
    .orderBy(desc(payments.createdAt))
    .limit(1)
    .get();

  const now = Date.now();
  const rawStr = serializeRaw(input.raw);

  // --- 2. BATCH phase (atomic) ------------------------------------------------
  // (a) The guarded transition. RETURNING id → rows.length tells us whether WE won.
  const orderUpdate = db
    .update(orders)
    .set({ status: "paid", paidAt: now, updatedAt: now })
    .where(and(eq(orders.id, orderId), inArray(orders.status, ["pending", "awaiting_payment"])))
    .returning({ id: orders.id });

  // (b) Payment upsert. Update is guarded to created/failed so it can never regress a row a
  // concurrent transition already promoted (identical values anyway) or clobber a refund.
  // The insert branch (no row at read time) is protected by the partial unique
  // (provider, providerRef): if two no-intent transitions race, the loser's INSERT violates
  // it and D1 rolls back the loser's ENTIRE batch — decrements included.
  const paymentUpsert = intent
    ? db
        .update(payments)
        .set({
          status: "paid",
          providerRef: input.providerRef ?? intent.providerRef,
          raw: rawStr ?? intent.raw,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        })
        .where(and(eq(payments.id, intent.id), inArray(payments.status, ["created", "failed"])))
    : db.insert(payments).values({
        id: nanoid(),
        orderId,
        provider,
        providerRef: input.providerRef ?? null,
        status: "paid",
        amount: order.totalAmount,
        currency: order.currency,
        raw: rawStr,
        createdAt: now,
        updatedAt: now,
      });

  // (c) One guarded decrement per tracked item. The double guard (stock IS NOT NULL AND
  // stock >= qty) means stock can never go negative and a product switched to untracked or
  // deleted between read and batch simply misses (→ conflict flag, step 4).
  const decrements = trackedItems.map((item) =>
    db
      .update(products)
      .set({ stock: sql`${products.stock} - ${item.quantity}` })
      .where(
        and(
          eq(products.id, item.productId),
          isNotNull(products.stock),
          gte(products.stock, item.quantity),
        ),
      )
      .returning({ id: products.id }),
  );

  const statements = [orderUpdate, paymentUpsert, ...decrements];
  const results = (await db.batch(
    statements as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  )) as unknown[];

  const transitioned = (results[0] as { id: string }[]).length > 0;
  const decrementApplied = trackedItems.map(
    (_, i) => ((results[DECREMENTS_BASE + i] as { id: string }[]) ?? []).length > 0,
  );

  // --- 3. Lost the race after the read said transitionable --------------------
  if (!transitioned) {
    // A concurrent transition committed between our read and our batch. Our guarded order
    // UPDATE hit 0 rows, but our decrements DID run — re-increment exactly the ones whose
    // RETURNING proved they applied (I1/I3). See the module comment for the residual window.
    const compensations = trackedItems
      .filter((_, i) => decrementApplied[i])
      .map((item) =>
        db
          .update(products)
          .set({ stock: sql`${products.stock} + ${item.quantity}` })
          .where(and(eq(products.id, item.productId), isNotNull(products.stock))),
      );
    if (compensations.length > 0) {
      await db.batch(compensations as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    }
    return { transitioned: false };
  }

  // --- 4. Transitioned, but some tracked decrement missed ---------------------
  if (decrementApplied.some((applied) => !applied)) {
    // Insufficient stock at payment time (or product deleted after the read). The order STAYS
    // paid — money moved — and the flag routes it to the merchant. Losing this follow-up to a
    // crash loses only the flag, never money or stock consistency.
    await db
      .update(orders)
      .set({ stockConflict: 1, updatedAt: Date.now() })
      .where(eq(orders.id, orderId))
      .run();
  }

  return { transitioned: true };
}

/** All items of one order (local copy — avoids importing orders.ts into the transition core). */
async function loadOrderItems(db: DrizzleDb, orderId: string): Promise<OrderItemRow[]> {
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).all();
}

/** productId → current stock for the TRACKED products among the items (stock IS NOT NULL now). */
async function loadTrackedStock(db: DrizzleDb, items: OrderItemRow[]): Promise<Map<string, number>> {
  const ids = [...new Set(items.map((i) => i.productId).filter((v): v is string => v !== null))];
  const tracked = new Map<string, number>();
  for (let i = 0; i < ids.length; i += D1_IN_CHUNK) {
    const chunk = ids.slice(i, i + D1_IN_CHUNK);
    const rows = await db
      .select({ id: products.id, stock: products.stock })
      .from(products)
      .where(inArray(products.id, chunk))
      .all();
    for (const row of rows) {
      if (row.stock !== null) tracked.set(row.id, row.stock);
    }
  }
  return tracked;
}
