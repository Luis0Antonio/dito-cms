import { desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { nanoid } from "nanoid";

import type { DrizzleDb } from "../../db/client";
import { orderHookDeliveries, orders } from "../../db/schema";
import type { AppEnv } from "../../lib/app";
import { getOrderHookConfig, maskUrl } from "./settings";
import { loadOrderItems } from "./orders";

import type {
  OrderHookActivity,
  OrderHookDelivery,
  OrderHookPayload,
  OrderHookTestResult,
} from "@/shared/api-types";

// Merchant notification webhook for PAID orders — the commerce twin of services/deploy-hook.ts
// (same mechanism: single URL, optional auth header, waitUntil fire-and-forget, delivery log in
// its own pruned table). It notifies a merchant system (email service, Zapier, ERP, a WhatsApp
// bridge) that money arrived. It has NOTHING to do with site rebuilds.
//
// The deploy hook (`fireDeployHook` / `triggerDeployHook`) must NEVER be imported or fired from
// any commerce code path — rebuilds are for merchant CONTENT edits only. A sale changes what the
// live commerce API answers (stock, availability), never what gets built into the static site.
//
// Callers fire this EXACTLY once per paid order: only when applyPaidTransition returned
// `transitioned: true` (the transition is the single choke point, so the flag is the dedupe).

const TIMEOUT_MS = 10_000;
/** How many delivery rows to retain; older rows are pruned on each insert (as deploy-hook). */
const MAX_DELIVERIES = 50;
/** Default page size for the activity list. */
const DEFAULT_LIST_LIMIT = 20;

/**
 * Deliver the order.paid notification for one order. No-op (logs nothing) when the hook is
 * disabled/unconfigured or the order does not exist. POSTs the {@link OrderHookPayload} JSON
 * with the optional auth header applied. Logs the attempt — event + order number + masked URL +
 * outcome — to order_hook_deliveries. NEVER throws: a delivery or logging failure must never
 * break (or fail) the checkout/webhook request that triggered it.
 */
export async function triggerOrderHook(
  db: DrizzleDb,
  env: Env,
  orderId: string,
): Promise<OrderHookTestResult> {
  // Config resolution decrypts the auth header value; treat ANY failure there (e.g. a missing
  // or rotated SETTINGS_ENC_KEY) as "not configured" rather than letting it escape — there is
  // no URL to log against in that case.
  let config: Awaited<ReturnType<typeof getOrderHookConfig>>;
  try {
    config = await getOrderHookConfig(db, env);
  } catch {
    return { ok: false, status: null, error: "Order hook config could not be read" };
  }
  if (!config || !config.enabled || !config.url) {
    return { ok: false, status: null, error: "Order hook is disabled or has no URL" };
  }

  const payload = await buildPayload(db, orderId);
  if (!payload) {
    return { ok: false, status: null, error: "Order not found" };
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  if (config.authHeaderName && config.authHeaderValue) {
    headers.set(config.authHeaderName, config.authHeaderValue);
  }

  let result: OrderHookTestResult;
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    result = { ok: res.ok, status: res.status };
    if (!res.ok) result.error = `HTTP ${res.status}`;
  } catch (err) {
    result = { ok: false, status: null, error: err instanceof Error ? err.message : "Request failed" };
  }

  try {
    await recordDelivery(db, {
      event: payload.event,
      detail: `#${payload.order.number}`,
      // Store only the MASKED URL — the raw URL never lands in the log (as deploy-hook).
      url: maskUrl(config.url),
      result,
    });
  } catch {
    // Logging is best-effort; never throw from the trigger path.
  }
  return result;
}

/**
 * Fire the order hook for a freshly paid order, fire-and-forget. Runs in `waitUntil` so it
 * never blocks or fails the response that triggered it — the buyer's checkout result (or the
 * webhook 200) must be invisible to notification problems. Mirrors fireDeployHook
 * (routes/admin-deploy-hook.ts); it lives here because 2D ships no commerce route files yet.
 */
export function fireOrderHook(c: Context<AppEnv>, orderId: string): void {
  const p = triggerOrderHook(c.get("db"), c.env, orderId).catch(() => {
    /* triggerOrderHook never rejects, but guard anyway */
  });
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* dev: no execution context → let it run detached */
  }
}

/** Build the order.paid payload: the admin-ish order DTO external systems act on. */
async function buildPayload(db: DrizzleDb, orderId: string): Promise<OrderHookPayload | null> {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return null;
  const items = await loadOrderItems(db, orderId);
  return {
    event: "order.paid",
    order: {
      id: order.id,
      number: order.number,
      status: order.status,
      email: order.email,
      customerName: order.customerName,
      items: items.map((i) => ({
        name: i.name,
        sku: i.sku,
        quantity: i.quantity,
        unitAmount: i.unitAmount,
        totalAmount: i.totalAmount,
      })),
      subtotalAmount: order.subtotalAmount,
      shippingAmount: order.shippingAmount,
      totalAmount: order.totalAmount,
      currency: order.currency,
      paidAt: order.paidAt,
    },
  };
}

/** Insert one delivery row, then prune to the most recent MAX_DELIVERIES rows (as deploy-hook). */
async function recordDelivery(
  db: DrizzleDb,
  row: { event: string; detail: string | null; url: string; result: OrderHookTestResult },
): Promise<void> {
  await db.insert(orderHookDeliveries).values({
    id: nanoid(),
    firedAt: Date.now(),
    event: row.event,
    detail: row.detail,
    url: row.url,
    ok: row.result.ok,
    status: row.result.status,
    error: row.result.error ?? null,
  });
  await db.run(
    sql`DELETE FROM order_hook_deliveries WHERE id NOT IN (
      SELECT id FROM order_hook_deliveries ORDER BY fired_at DESC LIMIT ${MAX_DELIVERIES}
    )`,
  );
}

/** Recent delivery attempts, newest first. Masked URLs only — never the raw hook URL. */
export async function listOrderHookDeliveries(
  db: DrizzleDb,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<OrderHookActivity> {
  const rows = await db
    .select()
    .from(orderHookDeliveries)
    .orderBy(desc(orderHookDeliveries.firedAt))
    .limit(limit)
    .all();
  const deliveries: OrderHookDelivery[] = rows.map((r) => ({
    id: r.id,
    firedAt: r.firedAt,
    event: r.event,
    detail: r.detail,
    urlPreview: r.url,
    ok: r.ok,
    status: r.status,
    error: r.error,
  }));
  return { deliveries };
}
