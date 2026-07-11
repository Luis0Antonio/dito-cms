// Payment provider abstraction for the store module. This layer is PURE HTTP: no database access,
// no Hono context, no routes. A driver turns "charge this order with this client token" into a
// definitive outcome, and turns an inbound webhook into a verified event — nothing more. The
// checkout/webhook orchestration (persisting intents, payment_events, the paid transition) lives
// in the route/service layer (phases 2D/2E) and consumes these shapes.
//
// Trust model (see culqi.ts for the provider specifics):
//   - A charge outcome is one of three DEFINITIVE states (paid / failed / requires_action) OR an
//     UNKNOWN — and unknown is a THROWN {@link ChargeUnknownError}, never a return value. Callers
//     leave the order awaiting_payment on a throw; they must never treat unknown as failed.
//   - Webhooks are untrusted hints. A driver re-fetches the resource from the provider by id and
//     returns a {@link VerifiedEvent} derived from the fetched state, or null to ignore silently.

import { createCulqiProvider } from "./culqi";
import type { CulqiRuntimeConfig } from "../settings";

/**
 * The minimal order data a driver needs to raise a charge. 2D adapts its order rows to this — the
 * driver never sees the full order model, only what a charge request requires.
 */
export interface ChargeOrderInput {
  /** Internal order id (goes to provider metadata for webhook-time correlation). */
  id: string;
  /** Human order number (goes to the charge description / metadata). */
  number: number;
  /** Total to charge, in minor units (céntimos) — already priced from the DB by 2D. */
  totalAmount: number;
  /** ISO 4217 currency code, e.g. `PEN`. */
  currency: string;
  /** Buyer email for the charge/receipt. */
  email: string;
}

/** The definitive statuses a charge can settle into (an UNKNOWN outcome is thrown, not returned). */
export type ChargeStatus = "paid" | "failed" | "requires_action";

/**
 * A DEFINITIVE charge outcome. Never returned for unknown/transient results — those throw
 * {@link ChargeUnknownError} so the caller can leave the order awaiting_payment.
 */
export interface ChargeResult {
  status: ChargeStatus;
  /** Provider charge id (e.g. Culqi `chr_…`), when one is known — even for a decline. */
  providerRef?: string;
  /** Machine-readable failure/action code (e.g. a decline_code, `requires_3ds`, `invalid_token`). */
  errorCode?: string;
  /** BUYER-SAFE message (the provider's user_message when available); never merchant/debug detail. */
  errorMessage?: string;
  /** REDACTED provider snapshot for audit — scalars only, never card data, keys, or request bodies. */
  raw?: unknown;
}

/**
 * Thrown when a charge outcome is UNKNOWN — timeout, 429, 5xx, network error, or an unparseable
 * "success" the driver cannot confirm. Money may or may not have moved, so the caller MUST leave
 * the order awaiting_payment (never failed) and let reconciliation / the webhook resolve it.
 * Carries the provider charge id when one is known, so reconciliation has something to fetch back.
 * NEVER thrown for a definitive outcome (paid / failed / requires_action).
 */
export class ChargeUnknownError extends Error {
  /** Provider charge id, when the driver saw one before the outcome became uncertain. */
  readonly providerRef?: string;

  constructor(message: string, providerRef?: string) {
    super(message);
    this.name = "ChargeUnknownError";
    this.providerRef = providerRef;
  }
}

/** The verified statuses a webhook can resolve to after fetch-back (refunded is post-payment). */
export type VerifiedStatus = "paid" | "failed" | "refunded";

/**
 * A webhook event whose truth was confirmed by re-fetching the resource from the provider — the
 * POSTed payload is never trusted directly. Null (from handleWebhook) means "ignore silently".
 */
export interface VerifiedEvent {
  /** Provider event id (e.g. Culqi `evt_…`) — used by 2E for payment_events dedupe. */
  eventId: string;
  /** Provider event type string (e.g. `charge.creation.succeeded`). */
  type: string;
  /** The charge id this event concerns (e.g. Culqi `chr_…`). */
  providerRef: string;
  /** The status DERIVED from the fetched resource, not from the posted payload. */
  verifiedStatus: VerifiedStatus;
  /**
   * OUR internal order id, lifted from the FETCHED charge's metadata (the charge path sends
   * `metadata.orderId`). Only set when the value is plausibly one of our ids — drivers must
   * validate the shape, never forward arbitrary metadata. This is the crash-recovery link:
   * when the payments intent row has no providerRef yet (crash between charge success and
   * the paid transition), 2E's webhook path can still resolve the order through this field.
   */
  orderId?: string;
  /** REDACTED snapshot of the fetched resource for audit — scalars only. */
  raw?: unknown;
}

/**
 * A payment gateway driver. Pure HTTP — no DB, no Hono. `cfg` is the decrypted runtime config for
 * the specific provider (today: {@link CulqiRuntimeConfig}; generalizing the config type across
 * providers is phase 3's job, not something to abstract for a single provider).
 */
export interface PaymentProvider {
  /** Stable provider key, matching the registry key (e.g. `culqi`). */
  key: string;
  /**
   * Raise a charge for an order using a client-tokenized payment source. Resolves to a DEFINITIVE
   * {@link ChargeResult}; throws {@link ChargeUnknownError} when the outcome is unknown/transient.
   */
  charge(cfg: CulqiRuntimeConfig, input: { order: ChargeOrderInput; token: string }): Promise<ChargeResult>;
  /**
   * Turn an inbound provider webhook into a {@link VerifiedEvent} by re-fetching the resource, or
   * return null to ignore it (unknown type, bad id shape, unverifiable, or any parse failure).
   */
  handleWebhook(cfg: CulqiRuntimeConfig, request: Request): Promise<VerifiedEvent | null>;
}

// --- Registry ---------------------------------------------------------------
// Provider key → driver. `culqi` is the only entry today; Izipay/Stripe/manual slot in later
// (phase 3) without touching call sites — 2D/2E resolve a driver purely by key. The driver import
// lives at the top of the file; only the registry wiring stays down here with its narration.

const PROVIDERS: Record<string, () => PaymentProvider> = {
  culqi: () => createCulqiProvider(),
};

/**
 * Resolve a payment driver by provider key, or null when the key is unknown. Callers (2D/2E)
 * decide what an unknown/disabled provider means; this only maps keys to drivers.
 */
export function getPaymentProvider(key: string): PaymentProvider | null {
  const factory = PROVIDERS[key];
  return factory ? factory() : null;
}
