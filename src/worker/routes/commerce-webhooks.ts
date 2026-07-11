import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import type { AppEnv } from "../lib/app";
import type { DrizzleDb } from "../db/client";
import { notFound } from "../lib/errors";
import { clientIp, enforceRateLimit } from "../lib/rate-limit";
import { orders, paymentEvents, payments, type PaymentRow } from "../db/schema";
import { isCommerceEnabled } from "../services/settings";
import { getCulqiConfig } from "../services/store/settings";
import { getPaymentProvider, type VerifiedEvent } from "../services/store/payments/types";
import { applyPaidTransition } from "../services/store/paid-transition";
import { fireOrderHook } from "../services/store/order-hook";

import type { ApiErrorBody } from "@/shared/api-types";

// Inbound payment-provider webhooks: POST /api/commerce/webhooks/:provider. Server-to-server —
// no auth (providers sign nothing; Culqi confirmed), no CORS, and NEVER an error status for a
// processable request: providers treat non-2xx as "retry me" (or worse, disable the endpoint),
// so every handled request answers 200 with a machine-readable `outcome`. The trust model does
// all the work instead:
//   - The driver re-fetches the charge from the provider (handleWebhook); the POSTed payload is
//     only ever a hint. Unverifiable input → outcome "ignored", nothing persisted.
//   - Verified events are deduped through the (provider, eventId) unique in payment_events —
//     redelivery is answered "duplicate" with ZERO side effects.
//   - State changes are the same guarded transitions the sync path uses (applyPaidTransition,
//     guarded UPDATEs), so a webhook can never regress a terminal order.
// Toggle-gated 404 like every other commerce route: when the Store module is off, this
// endpoint does not exist.
export const commerceWebhookRouter = new Hono<AppEnv>();

/**
 * Rate limit: fixed 60s windows per source IP over the D1 `checkout_hits` table
 * (lib/rate-limit.ts). 120/min absorbs a genuinely busy store's event bursts and provider
 * retries while capping the fetch-back amplification an attacker could otherwise drive
 * (every well-formed body costs us an outbound charge fetch).
 */
const WEBHOOK_RATE_LIMIT = { scope: "webhook", limit: 120, windowSeconds: 60 } as const;

type WebhookOutcome = "applied" | "duplicate" | "ignored" | "unmatched" | "error";

// Module gate: invisible when disabled (as routes/commerce.ts).
commerceWebhookRouter.use("*", async (c, next) => {
  if (!(await isCommerceEnabled(c.get("db")))) {
    throw notFound("The Store module is not enabled");
  }
  await next();
});

/** The always-200 webhook answer; outcome is logged so operators can trace deliveries. */
function respond(c: Context<AppEnv>, outcome: WebhookOutcome): Response {
  // debug level: the lint policy reserves warn/error for problems, and most outcomes are routine.
  console.debug(`[commerce] webhook ${c.req.param("provider")}: ${outcome}`);
  return c.json({ received: true, outcome });
}

commerceWebhookRouter.post("/:provider", async (c) => {
  const db = c.get("db");

  const rl = await enforceRateLimit(db, { ...WEBHOOK_RATE_LIMIT, key: clientIp(c.req.raw) });
  if (!rl.allowed) {
    c.header("Retry-After", String(rl.retryAfterSeconds ?? WEBHOOK_RATE_LIMIT.windowSeconds));
    return c.json(
      { error: { code: "rate_limited", message: "Too many requests" } } satisfies ApiErrorBody,
      429,
    );
  }

  const providerKey = c.req.param("provider");
  const provider = getPaymentProvider(providerKey);
  if (!provider) throw notFound("Unknown payment provider");

  // Resolve the provider's runtime config. Unconfigured — or unreadable (missing/rotated
  // SETTINGS_ENC_KEY) — means we cannot verify anything: answer 200 "ignored" rather than
  // erroring back at the provider. A DISABLED-but-configured gateway still processes: verified
  // events about real money keep the order truthful even if the merchant just switched off
  // new checkouts.
  let cfg: Awaited<ReturnType<typeof getCulqiConfig>>;
  try {
    cfg = await getCulqiConfig(db, c.env);
  } catch (err) {
    console.error("[commerce] webhook config unavailable:", err);
    return respond(c, "ignored");
  }
  if (!cfg) return respond(c, "ignored");

  // Drivers resolve every uncertainty to null (ignore); a throw here would be a driver bug —
  // still never let it become a 5xx storm at the provider.
  let event: VerifiedEvent | null;
  try {
    event = await provider.handleWebhook(cfg, c.req.raw);
  } catch (err) {
    console.error("[commerce] webhook driver error:", err);
    return respond(c, "error");
  }
  if (!event) return respond(c, "ignored");

  try {
    return respond(c, await processVerifiedEvent(c, db, providerKey, event));
  } catch (err) {
    // A processing failure is OUR problem, never the provider's: log it, answer 200. The
    // event row (when it got that far) or the provider's redelivery preserves the evidence.
    console.error("[commerce] webhook processing error:", err);
    return respond(c, "error");
  }
});

/**
 * Persist + apply one VERIFIED event. Order of operations is load-bearing:
 *   1. DEDUPE — insert into payment_events; the (provider, eventId) unique makes redelivery
 *      a conflict → "duplicate", and NOTHING else runs (webhook idempotency).
 *   2. RESOLVE the order: the payments row carrying (provider, providerRef) wins; else the
 *      driver-validated `event.orderId` (charge metadata — the crash-recovery link for an
 *      intent row that never got its providerRef) if that order exists; else the event stays
 *      recorded with a null orderId for merchant review → "unmatched".
 *   3. APPLY the verified status through guarded transitions (see the appliers).
 */
async function processVerifiedEvent(
  c: Context<AppEnv>,
  db: DrizzleDb,
  providerKey: string,
  event: VerifiedEvent,
): Promise<WebhookOutcome> {
  // --- 1. Dedupe ---------------------------------------------------------------
  // Inserted with a null orderId (resolution hasn't run yet); updated below once resolved.
  const inserted = await db
    .insert(paymentEvents)
    .values({
      id: nanoid(),
      provider: providerKey,
      eventId: event.eventId,
      type: event.type,
      orderId: null,
      payload: serializeRaw(event.raw),
      processedAt: Date.now(),
    })
    .onConflictDoNothing()
    .returning({ id: paymentEvents.id });
  if (inserted.length === 0) return "duplicate";
  const eventRowId = inserted[0].id;

  // --- 2. Resolve the order ------------------------------------------------------
  const refRow = await db
    .select()
    .from(payments)
    .where(and(eq(payments.provider, providerKey), eq(payments.providerRef, event.providerRef)))
    .get();
  let orderId: string | null = refRow?.orderId ?? null;
  if (!orderId && event.orderId) {
    const order = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, event.orderId))
      .get();
    if (order) orderId = order.id;
  }
  if (!orderId) return "unmatched";
  await db.update(paymentEvents).set({ orderId }).where(eq(paymentEvents.id, eventRowId)).run();

  // --- 3. Apply -------------------------------------------------------------------
  switch (event.verifiedStatus) {
    case "paid": {
      const { transitioned } = await applyPaidTransition(db, {
        orderId,
        provider: providerKey,
        providerRef: event.providerRef,
        raw: event.raw,
      });
      // Fire the order hook EXACTLY once per paid order — only when THIS delivery performed
      // the transition (redeliveries and sync-path winners return transitioned: false).
      if (transitioned) fireOrderHook(c, orderId);
      break;
    }
    case "failed":
      await applyFailed(db, providerKey, orderId, event, refRow);
      break;
    case "refunded":
      await applyRefunded(db, providerKey, orderId, event, refRow);
      break;
  }
  return "applied";
}

/**
 * Verified FAILED charge: the order exits `awaiting_payment` → `failed` — ONLY that
 * transition; any other state (paid, terminal, or still pending with no charge attempt) is
 * never touched. The payment row moves `created` → `failed`: the (provider, providerRef)
 * match when one exists, else the order's newest ref-less `created` intent row (the crash
 * case). Both updates are guarded so a concurrent paid/refund can never be overwritten;
 * decline detail stays in `raw` (the fetched charge carries no separate buyer message here).
 */
async function applyFailed(
  db: DrizzleDb,
  providerKey: string,
  orderId: string,
  event: VerifiedEvent,
  refRow: PaymentRow | undefined,
): Promise<void> {
  const now = Date.now();
  const target = refRow ?? (await findCreatedIntent(db, providerKey, orderId));

  const statements: BatchItem<"sqlite">[] = [
    db
      .update(orders)
      .set({ status: "failed", updatedAt: now })
      .where(and(eq(orders.id, orderId), eq(orders.status, "awaiting_payment"))),
  ];
  if (target) {
    statements.push(
      db
        .update(payments)
        .set({
          status: "failed",
          providerRef: target.providerRef ?? event.providerRef,
          raw: serializeRaw(event.raw) ?? target.raw,
          updatedAt: now,
        })
        .where(and(eq(payments.id, target.id), eq(payments.status, "created"))),
    );
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/**
 * Verified REFUND: keep state truthful ahead of the phase-3 refund UX — the payment row
 * (`created`/`paid` → `refunded`, guarded) and the order (`paid`/`fulfilled` → `refunded`,
 * guarded; other states never touched). No stock re-increment and no buyer messaging here —
 * that is deliberately phase 3; this only records what the provider verifiably did.
 */
async function applyRefunded(
  db: DrizzleDb,
  providerKey: string,
  orderId: string,
  event: VerifiedEvent,
  refRow: PaymentRow | undefined,
): Promise<void> {
  const now = Date.now();
  const target = refRow ?? (await findCreatedIntent(db, providerKey, orderId));

  const statements: BatchItem<"sqlite">[] = [
    db
      .update(orders)
      .set({ status: "refunded", updatedAt: now })
      .where(and(eq(orders.id, orderId), inArray(orders.status, ["paid", "fulfilled"]))),
  ];
  if (target) {
    statements.push(
      db
        .update(payments)
        .set({
          status: "refunded",
          providerRef: target.providerRef ?? event.providerRef,
          raw: serializeRaw(event.raw) ?? target.raw,
          updatedAt: now,
        })
        .where(and(eq(payments.id, target.id), inArray(payments.status, ["created", "paid"]))),
    );
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/** The order's newest ref-less `created` intent row for this provider (crash-recovery target). */
async function findCreatedIntent(
  db: DrizzleDb,
  providerKey: string,
  orderId: string,
): Promise<PaymentRow | undefined> {
  return db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        eq(payments.provider, providerKey),
        eq(payments.status, "created"),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1)
    .get();
}

/** JSON-encode a redacted raw snapshot; undefined/unencodable → null (as checkout.ts). */
function serializeRaw(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  try {
    const s = JSON.stringify(raw);
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
}
