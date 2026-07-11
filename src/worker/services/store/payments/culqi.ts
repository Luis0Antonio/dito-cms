import type { CulqiRuntimeConfig } from "../settings";
import type {
  ChargeOrderInput,
  ChargeResult,
  PaymentProvider,
  VerifiedEvent,
  VerifiedStatus,
} from "./types";
import { ChargeUnknownError } from "./types";

// Culqi payment driver — pure HTTP, no DB, no Hono. Server-side charge creation and webhook
// verification against the Culqi v2 API (raw fetch, no SDK). The client tokenizes the card/Yape
// source in-browser with the public key; this driver receives that token id and creates the charge
// with the secret key.
//
// Trust model (verified against Culqi's live OpenAPI spec — these are the load-bearing gotchas):
//   - Success is `outcome.type === "venta_exitosa"` on an HTTP 201, NOTHING ELSE. The top-level
//     `paid` flag is a SETTLEMENT indicator that stays false on a fully authorized charge — it is
//     never a buyer-payment signal, so we never read it.
//   - A 201 without venta_exitosa (or an unparseable 201) means money MAY have moved: that is an
//     UNKNOWN outcome (throw ChargeUnknownError with the charge id), never a definitive failure.
//   - Webhooks are UNSIGNED (Culqi ships no HMAC/signature). The posted payload is an untrusted
//     hint; the authority is a server-to-server fetch-back of the charge by id. Any uncertainty in
//     the webhook path (bad shape, parse failure, fetch-back non-200/network) → ignore (null).

const API_BASE = "https://api.culqi.com/v2";
/** Charges are synchronous; 15s covers the issuer round-trip with margin before we call it unknown. */
const CHARGE_TIMEOUT_MS = 15_000;

// Shape validators (permissive: accept test+live, gate on prefix+charset, not exact length, since
// Culqi could change the id tail). See the Culqi fact sheet §10.
/** Client source token: card (`tkn_`), Yape (`ype_`), or saved card (`crd_`). */
const SOURCE_TOKEN_RE = /^(tkn|ype|crd)_(test|live)_[A-Za-z0-9]+$/;
/** Charge id. */
const CHARGE_ID_RE = /^chr_(test|live)_[A-Za-z0-9]+$/;
/** Event id. */
const EVENT_ID_RE = /^evt_(test|live)_[A-Za-z0-9]+$/;
/**
 * OUR order id, as echoed back in charge `metadata.orderId` (the charge path sends it).
 * Order ids are default-alphabet `nanoid()` values: exactly 21 chars of [A-Za-z0-9_-].
 * Anything else in the metadata is NOT ours — leave the event's orderId unset.
 */
const ORDER_ID_RE = /^[A-Za-z0-9_-]{21}$/;

/** Culqi `description` bound is 5–80 chars; `Pedido #<n>` is always ≥8, so only the ceiling bites. */
const DESCRIPTION_MAX = 80;

/** Buyer-safe generic message for failures whose provider detail is NOT buyer-appropriate (our bug / misconfig). */
const GENERIC_DECLINE_MESSAGE = "No pudimos procesar el pago. Verifica tus datos o intenta con otro medio de pago.";
/** Buyer-safe message for the 3DS/REVIEW branch (v1 descopes 3DS; 2D surfaces this as a failed attempt). */
const REQUIRES_ACTION_MESSAGE = "Tu banco requiere una verificación adicional que aún no está disponible. Intenta con otra tarjeta.";

/** A Culqi charge object, loosely typed — we only read a handful of fields and validate their shape. */
interface CulqiChargeLike {
  id?: unknown;
  outcome?: { type?: unknown; code?: unknown; user_message?: unknown } | null;
  amount?: unknown;
  amount_refunded?: unknown;
  current_amount?: unknown;
  currency_code?: unknown;
  capture?: unknown;
  capture_date?: unknown;
  reference_code?: unknown;
  authorization_code?: unknown;
  decline_code?: unknown;
  code?: unknown;
  type?: unknown;
  charge_id?: unknown;
  user_message?: unknown;
  action_code?: unknown;
  metadata?: unknown;
}

/**
 * Build the REDACTED audit snapshot: an ALLOWLIST pick of scalars (+ the safe `outcome` messages).
 * Constructed fresh so no unlisted field can leak — never `delete raw.source`. NEVER includes the
 * `source` object (card data), request bodies, or keys. Reused at all three raw sites (charge
 * success, charge error, webhook fetched charge) so redaction is defined once.
 */
function redactCharge(charge: CulqiChargeLike): Record<string, unknown> {
  const outcome = charge.outcome;
  return {
    id: scalar(charge.id),
    outcome: outcome
      ? { type: scalar(outcome.type), code: scalar(outcome.code), user_message: scalar(outcome.user_message) }
      : undefined,
    amount: scalar(charge.amount),
    amount_refunded: scalar(charge.amount_refunded),
    current_amount: scalar(charge.current_amount),
    currency_code: scalar(charge.currency_code),
    capture: scalar(charge.capture),
    capture_date: scalar(charge.capture_date),
    reference_code: scalar(charge.reference_code),
    authorization_code: scalar(charge.authorization_code),
    decline_code: scalar(charge.decline_code),
    code: scalar(charge.code),
    type: scalar(charge.type),
  };
}

/** Keep only JSON scalars in the redacted snapshot; drop objects/arrays so nothing nested leaks. */
function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" ? (value as string | number | boolean) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse a Response body as JSON, or undefined when the body is not valid JSON (defensive). */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Culqi payment driver. `fetchImpl` is injectable so the mapping logic can be exercised without the
 * network (defaults to `globalThis.fetch`); the registry constructs it with the default.
 */
export function createCulqiProvider(fetchImpl: typeof fetch = globalThis.fetch): PaymentProvider {
  return {
    key: "culqi",
    charge: (cfg, input) => charge(cfg, input, fetchImpl),
    handleWebhook: (cfg, request) => handleWebhook(cfg, request, fetchImpl),
  };
}

async function charge(
  cfg: CulqiRuntimeConfig,
  input: { order: ChargeOrderInput; token: string },
  fetchImpl: typeof fetch,
): Promise<ChargeResult> {
  const { order, token } = input;

  // Reject a malformed token BEFORE spending a network call — a definitive, non-retryable failure
  // (the charge never happened). Buyer message stays generic; the code carries the reason.
  if (!SOURCE_TOKEN_RE.test(token)) {
    return {
      status: "failed",
      errorCode: "invalid_token",
      errorMessage: GENERIC_DECLINE_MESSAGE,
    };
  }

  const body = {
    amount: order.totalAmount,
    currency_code: order.currency,
    email: order.email,
    source_id: token,
    description: `Pedido #${order.number}`.slice(0, DESCRIPTION_MAX),
    metadata: { orderId: order.id, orderNumber: String(order.number) },
  };

  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}/charges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHARGE_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error or timeout (AbortSignal) — outcome unknown; money may have moved.
    throw new ChargeUnknownError(
      `Culqi charge request failed: ${err instanceof Error ? err.message : "network error"}`,
    );
  }

  return mapChargeResponse(res, await readJson(res));
}

/**
 * Map a Culqi charge HTTP response to a definitive {@link ChargeResult}, or throw
 * {@link ChargeUnknownError} for unknown/transient outcomes. HTTP STATUS is the primary
 * discriminator; the body only refines it — so a 402 is `failed` even if the body is garbage, and
 * only a 201 + `venta_exitosa` is `paid`.
 */
function mapChargeResponse(res: Response, parsed: unknown): ChargeResult {
  const charge = (isObject(parsed) ? parsed : {}) as CulqiChargeLike;
  const chargeId = asString(charge.id);

  // 201 — the ONLY success status. Paid iff outcome.type === "venta_exitosa" (never the `paid` flag).
  if (res.status === 201) {
    if (isObject(parsed) && charge.outcome && scalar(charge.outcome.type) === "venta_exitosa") {
      return { status: "paid", providerRef: chargeId, raw: redactCharge(charge) };
    }
    // 201 without venta_exitosa, or an unparseable body → money MAY have moved: UNKNOWN, not failed.
    throw new ChargeUnknownError(
      "Culqi returned 201 without a venta_exitosa outcome — charge state unconfirmed",
      chargeId,
    );
  }

  // 200 — the 3DS branch. `action_code: "REVIEW"` = authentication required; the charge was NEVER
  // captured (nothing to void). v1 descopes 3DS → requires_action (2D surfaces it as a failed attempt).
  if (res.status === 200) {
    if (scalar(charge.action_code) === "REVIEW") {
      return {
        status: "requires_action",
        errorCode: "requires_3ds",
        errorMessage: REQUIRES_ACTION_MESSAGE,
        raw: redactCharge(charge),
      };
    }
    // Any other 200 is undocumented — treat the money state as unknown rather than guessing.
    throw new ChargeUnknownError("Culqi returned an unexpected 200 response", chargeId);
  }

  // 402 — definitive card decline. `user_message` IS buyer-safe. A declined charge can still carry a
  // charge_id (a charge record exists); surface it as providerRef for reconciliation.
  if (res.status === 402) {
    return {
      status: "failed",
      providerRef: chargeId ?? asString(charge.charge_id),
      errorCode: asString(charge.decline_code) ?? asString(charge.code) ?? "card_error",
      errorMessage: asString(charge.user_message) ?? GENERIC_DECLINE_MESSAGE,
      raw: redactCharge(charge),
    };
  }

  // 400/401/404/422 — deterministic, non-retryable: OUR bug or a misconfig; the charge did not
  // happen. Merchant-facing detail goes in errorCode/raw; the buyer message stays generic.
  if (res.status === 400 || res.status === 401 || res.status === 404 || res.status === 422) {
    return {
      status: "failed",
      providerRef: chargeId ?? asString(charge.charge_id),
      errorCode: REQUEST_ERROR_CODES[res.status],
      errorMessage: GENERIC_DECLINE_MESSAGE,
      raw: redactCharge(charge),
    };
  }

  // 429 / 5xx / anything else — transient or unexpected: UNKNOWN, leave the order awaiting_payment.
  throw new ChargeUnknownError(`Culqi charge returned HTTP ${res.status}`, chargeId ?? asString(charge.charge_id));
}

/** HTTP status → stable merchant-facing errorCode for the deterministic non-retryable failures. */
const REQUEST_ERROR_CODES: Record<number, string> = {
  400: "invalid_request",
  401: "auth_error",
  404: "resource_error",
  422: "invalid_request",
};

// --- Webhooks ---------------------------------------------------------------

/** Known charge/refund event families. Anything else (tokens, orders, …) → ignore. */
function isKnownEventType(type: string): boolean {
  return type.startsWith("charge.") || type.startsWith("refund.");
}

/**
 * Verify an inbound Culqi webhook by re-fetching the charge — the posted payload is NEVER trusted.
 * Returns a {@link VerifiedEvent} only when a valid event resolves to a real charge; returns null
 * (ignore silently) for anything unrecognized or unverifiable: bad JSON, wrong `object`, unknown
 * event type, malformed ids, or a fetch-back that does not 200. Unlike the charge path, NO
 * uncertainty here ever throws — Culqi retries webhooks, so ignoring is always safe.
 */
async function handleWebhook(
  cfg: CulqiRuntimeConfig,
  request: Request,
  fetchImpl: typeof fetch,
): Promise<VerifiedEvent | null> {
  // 1. Parse the envelope defensively.
  let event: unknown;
  try {
    event = await request.json();
  } catch {
    return null;
  }
  if (!isObject(event)) return null;

  if (scalar(event.object) !== "event") return null;
  const eventId = asString(event.id);
  const type = asString(event.type);
  if (!eventId || !EVENT_ID_RE.test(eventId)) return null;
  if (!type || !isKnownEventType(type)) return null;

  // 2. `data` is a JSON STRING or an object (the spec is self-inconsistent) — handle both.
  const data = parseWebhookData(event.data);
  if (!isObject(data)) return null;

  // 3. Extract the charge id: charge events carry `data.id`; refund events carry `data.charge_id`.
  const chargeId = type.startsWith("refund.") ? asString(data.charge_id) : asString(data.id);
  if (!chargeId || !CHARGE_ID_RE.test(chargeId)) return null;

  // 4. Fetch the charge back — the ONLY source of truth. Any non-200 / network error → ignore.
  const charge = await fetchChargeBack(cfg, chargeId, fetchImpl);
  if (!charge) return null;

  const verifiedStatus = deriveVerifiedStatus(charge);
  // 5. Lift OUR order id from the fetched charge's metadata (sent at charge time). This is the
  // crash-recovery link for a charge whose payments row never got its providerRef. Only this ONE
  // validated field is lifted — metadata is deliberately NOT part of the redacted `raw` snapshot.
  return {
    eventId,
    type,
    providerRef: chargeId,
    verifiedStatus,
    orderId: extractMetadataOrderId(charge),
    raw: redactCharge(charge),
  };
}

/** `metadata.orderId` from a fetched charge, iff it is shaped like one of our nanoid order ids. */
function extractMetadataOrderId(charge: CulqiChargeLike): string | undefined {
  if (!isObject(charge.metadata)) return undefined;
  const orderId = charge.metadata.orderId;
  return typeof orderId === "string" && ORDER_ID_RE.test(orderId) ? orderId : undefined;
}

/** Coerce a webhook `data` field (JSON string OR object) into an object, or undefined on failure. */
function parseWebhookData(data: unknown): Record<string, unknown> | undefined {
  if (isObject(data)) return data;
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** GET /charges/{id} with the secret key. Returns the parsed charge on HTTP 200, else undefined. */
async function fetchChargeBack(
  cfg: CulqiRuntimeConfig,
  chargeId: string,
  fetchImpl: typeof fetch,
): Promise<CulqiChargeLike | undefined> {
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}/charges/${chargeId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.secretKey}` },
      signal: AbortSignal.timeout(CHARGE_TIMEOUT_MS),
    });
  } catch {
    return undefined; // Network error / timeout — never trust the posted payload instead.
  }
  if (res.status !== 200) return undefined; // Charge doesn't exist / auth problem — ignore.
  const parsed = await readJson(res);
  return isObject(parsed) ? (parsed as CulqiChargeLike) : undefined;
}

/**
 * Derive the verified status from a FETCHED charge. Refund is checked FIRST: a refunded charge
 * still carries its original `venta_exitosa` outcome, so a paid-first check would misreport it as
 * paid. `amount_refunded > 0` or `current_amount < amount` ⇒ refunded; else venta_exitosa ⇒ paid;
 * else the charge exists but never succeeded ⇒ failed.
 */
function deriveVerifiedStatus(charge: CulqiChargeLike): VerifiedStatus {
  const amount = asNumber(charge.amount);
  const amountRefunded = asNumber(charge.amount_refunded) ?? 0;
  const currentAmount = asNumber(charge.current_amount);

  if (amountRefunded > 0 || (amount !== undefined && currentAmount !== undefined && currentAmount < amount)) {
    return "refunded";
  }
  if (charge.outcome && scalar(charge.outcome.type) === "venta_exitosa") return "paid";
  return "failed";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
