import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

import type { ApiErrorBody, ApiErrorCode } from "@/shared/api-types";
import { BYTES_PER_GB } from "@/shared/constants";

/** Thrown anywhere in the worker; the global error handler renders the envelope. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly fieldErrors?: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message: string,
    fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export const badRequest = (message: string, fieldErrors?: Record<string, string>): ApiError =>
  new ApiError(400, "bad_request", message, fieldErrors);
export const validationError = (message: string, fieldErrors?: Record<string, string>): ApiError =>
  new ApiError(400, "validation_error", message, fieldErrors);
export const unauthorized = (message = "Authentication required"): ApiError =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message = "Forbidden"): ApiError =>
  new ApiError(403, "forbidden", message);
export const notFound = (message = "Not found"): ApiError =>
  new ApiError(404, "not_found", message);
export const conflict = (message: string, fieldErrors?: Record<string, string>): ApiError =>
  new ApiError(409, "conflict", message, fieldErrors);
export const rateLimited = (message = "Too many requests"): ApiError =>
  new ApiError(429, "rate_limited", message);
export const payloadTooLarge = (message: string): ApiError =>
  new ApiError(413, "payload_too_large", message);
export const unsupportedMediaType = (message: string): ApiError =>
  new ApiError(415, "unsupported_media_type", message);

/**
 * A media upload would push stored media past the deployment's storage limit. 507 (Insufficient
 * Storage) rather than 413 — proxies special-case 413 (request-entity-too-large) — carrying the
 * current used/limit figures so the caller can report where to free space.
 */
export const storageLimitExceeded = (usedBytes: number, limitBytes: number): ApiError => {
  const gb = (n: number): string => (n / BYTES_PER_GB).toFixed(2);
  return new ApiError(
    507,
    "storage_limit_exceeded",
    `Storage limit reached (${gb(usedBytes)} GB of ${gb(limitBytes)} GB used). Delete files to free space.`,
  );
};

/** Flatten a ZodError into the fieldErrors map keyed by dotted path. */
export function zodToFieldErrors(err: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

/** Build the wire-format error body. */
export function toErrorBody(err: unknown): { status: ContentfulStatusCode; body: ApiErrorBody } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, fieldErrors: err.fieldErrors } },
    };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "validation_error",
          message: "Validation failed",
          fieldErrors: zodToFieldErrors(err),
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "Internal server error" } },
  };
}
