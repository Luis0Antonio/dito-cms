import { Hono } from "hono";

import type { AppEnv } from "../lib/app";
import { badRequest, notFound } from "../lib/errors";
import { isFormsEnabled } from "../services/settings";
import {
  createContactForm,
  deleteContactForm,
  getContactFormDetail,
  listContactForms,
  setContactFormFields,
  updateContactForm,
} from "../services/contact-forms";

import type {
  ContactFormFieldInput,
  ContactFormFieldType,
  CreateContactFormInput,
  SetContactFormFieldsInput,
  UpdateContactFormInput,
} from "@/shared/api-types";

export const contactFormsRouter = new Hono<AppEnv>();

// Module gate: behave as if these routes don't exist when the Forms module is disabled
// (mirrors the Store module gate in admin-store.ts). Auth is already applied upstream.
contactFormsRouter.use("*", async (c, next) => {
  if (!(await isFormsEnabled(c.get("db")))) {
    throw notFound("The Forms module is not enabled");
  }
  await next();
});

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readFields(raw: unknown): ContactFormFieldInput[] {
  if (!Array.isArray(raw)) throw badRequest("`fields` must be an array");
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) throw badRequest(`fields[${i}] must be an object`);
    const field = item as Record<string, unknown>;
    return {
      name: asString(field.name) ?? "",
      label: asString(field.label) ?? "",
      type: field.type as ContactFormFieldType,
      required: field.required === true,
      options:
        typeof field.options === "object" && field.options !== null
          ? (field.options as ContactFormFieldInput["options"])
          : undefined,
    };
  });
}

contactFormsRouter.get("/", async (c) => {
  const forms = await listContactForms(c.get("db"));
  return c.json({ forms });
});

contactFormsRouter.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<CreateContactFormInput>;
  const name = asString(body.name);
  if (!name) throw badRequest("name is required");
  const form = await createContactForm(c.get("db"), {
    name,
    fields: body.fields === undefined ? undefined : readFields(body.fields),
  });
  return c.json({ form }, 201);
});

contactFormsRouter.get("/:id", async (c) => {
  const form = await getContactFormDetail(c.get("db"), c.req.param("id"));
  return c.json({ form });
});

contactFormsRouter.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: UpdateContactFormInput = {};
  if ("name" in body) patch.name = asString(body.name) ?? "";
  if ("enabled" in body) patch.enabled = body.enabled === true;
  if ("rateLimitMax" in body && typeof body.rateLimitMax === "number") {
    patch.rateLimitMax = body.rateLimitMax;
  }
  if ("rateLimitWindowSeconds" in body && typeof body.rateLimitWindowSeconds === "number") {
    patch.rateLimitWindowSeconds = body.rateLimitWindowSeconds;
  }
  const form = await updateContactForm(c.get("db"), c.req.param("id"), patch);
  return c.json({ form });
});

contactFormsRouter.put("/:id/fields", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<SetContactFormFieldsInput>;
  const form = await setContactFormFields(c.get("db"), c.req.param("id"), {
    fields: readFields(body.fields),
  });
  return c.json({ form });
});

contactFormsRouter.delete("/:id", async (c) => {
  await deleteContactForm(c.get("db"), c.req.param("id"));
  return c.body(null, 204);
});
