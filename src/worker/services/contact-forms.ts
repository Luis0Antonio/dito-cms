import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import type { DrizzleDb } from "../db/client";
import {
  contactFormFields,
  contactForms,
  contactFormSubmissions,
  type ContactFormFieldRow,
  type ContactFormRow,
  type ContactFormSubmissionRow,
} from "../db/schema";
import { badRequest, conflict, notFound, rateLimited, validationError } from "../lib/errors";
import { hashString } from "../lib/hash";

import { fieldNameError } from "@/shared/slug";
import type {
  ContactFormDetail,
  ContactFormFieldDTO,
  ContactFormFieldInput,
  ContactFormFieldOptions,
  ContactFormFieldType,
  ContactFormSubmissionDTO,
  ContactFormSummary,
  CreateContactFormInput,
  SetContactFormFieldsInput,
  UpdateContactFormInput,
} from "@/shared/api-types";

const FIELD_TYPES = new Set<ContactFormFieldType>([
  "text",
  "email",
  "textarea",
  "number",
  "checkbox",
  "select",
]);

const DEFAULT_FIELDS: ContactFormFieldInput[] = [
  { name: "name", label: "Name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "message", label: "Message", type: "textarea", required: true },
];

interface NormalizedField {
  name: string;
  label: string;
  type: ContactFormFieldType;
  required: boolean;
  options: ContactFormFieldOptions;
}

function parseOptions(raw: string): ContactFormFieldOptions {
  try {
    const parsed = JSON.parse(raw) as ContactFormFieldOptions;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function mapField(row: ContactFormFieldRow): ContactFormFieldDTO {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    type: row.type,
    required: row.required,
    options: parseOptions(row.options),
    sortOrder: row.sortOrder,
  };
}

function mapSubmission(row: ContactFormSubmissionRow): ContactFormSubmissionDTO {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    id: row.id,
    data,
    createdAt: row.createdAt,
    userAgent: row.userAgent,
  };
}

async function findFormById(db: DrizzleDb, id: string): Promise<ContactFormRow> {
  const row = await db.select().from(contactForms).where(eq(contactForms.id, id)).get();
  if (!row) throw notFound("Contact form not found");
  return row;
}

async function findFormByPublicKey(db: DrizzleDb, publicKey: string): Promise<ContactFormRow> {
  const row = await db
    .select()
    .from(contactForms)
    .where(eq(contactForms.publicKey, publicKey))
    .get();
  if (!row || !row.enabled) throw notFound("Contact form not found");
  return row;
}

async function loadFields(db: DrizzleDb, formId: string): Promise<ContactFormFieldRow[]> {
  return db
    .select()
    .from(contactFormFields)
    .where(eq(contactFormFields.formId, formId))
    .orderBy(asc(contactFormFields.sortOrder))
    .all();
}

async function countSubmissionsByForm(db: DrizzleDb): Promise<Map<string, number>> {
  const rows = await db
    .select({ formId: contactFormSubmissions.formId, n: count() })
    .from(contactFormSubmissions)
    .groupBy(contactFormSubmissions.formId)
    .all();
  return new Map(rows.map((r) => [r.formId, r.n]));
}

async function countFieldsByForm(db: DrizzleDb): Promise<Map<string, number>> {
  const rows = await db
    .select({ formId: contactFormFields.formId, n: count() })
    .from(contactFormFields)
    .groupBy(contactFormFields.formId)
    .all();
  return new Map(rows.map((r) => [r.formId, r.n]));
}

function mapSummary(
  row: ContactFormRow,
  fieldCountByForm: Map<string, number>,
  submissionCountByForm: Map<string, number>,
): ContactFormSummary {
  return {
    id: row.id,
    name: row.name,
    publicKey: row.publicKey,
    enabled: row.enabled,
    rateLimitMax: row.rateLimitMax,
    rateLimitWindowSeconds: row.rateLimitWindowSeconds,
    fieldCount: fieldCountByForm.get(row.id) ?? 0,
    submissionCount: submissionCountByForm.get(row.id) ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeField(input: ContactFormFieldInput, index: number): NormalizedField {
  const prefix = `fields.${index}`;
  const name = input.name.trim();
  const nameErr = fieldNameError(name);
  if (nameErr) throw validationError(nameErr, { [`${prefix}.name`]: nameErr });
  const label = input.label.trim();
  if (!label) throw validationError("Label is required", { [`${prefix}.label`]: "Label is required" });
  if (!FIELD_TYPES.has(input.type)) {
    throw validationError("Unknown field type", { [`${prefix}.type`]: "Unknown field type" });
  }
  const options: ContactFormFieldOptions = {};
  if (input.type === "select") {
    const choices = (input.options?.choices ?? [])
      .map((choice) => choice.trim())
      .filter(Boolean);
    if (choices.length === 0) {
      throw validationError("Select fields need at least one choice", {
        [`${prefix}.options.choices`]: "Add at least one choice",
      });
    }
    options.choices = Array.from(new Set(choices));
  }
  return {
    name,
    label,
    type: input.type,
    required: input.required === true,
    options,
  };
}

function normalizeFields(input: ContactFormFieldInput[]): NormalizedField[] {
  const normalized = input.map(normalizeField);
  const seen = new Set<string>();
  normalized.forEach((field, index) => {
    if (seen.has(field.name)) {
      throw validationError(`Duplicate field name "${field.name}"`, {
        [`fields.${index}.name`]: "Field names must be unique",
      });
    }
    seen.add(field.name);
  });
  return normalized;
}

function validateRateLimitPatch(input: UpdateContactFormInput): Partial<typeof contactForms.$inferInsert> {
  const values: Partial<typeof contactForms.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw validationError("Name is required", { name: "Name is required" });
    values.name = name;
  }
  if (input.enabled !== undefined) values.enabled = input.enabled;
  if (input.rateLimitMax !== undefined) {
    const value = Math.trunc(input.rateLimitMax);
    if (!Number.isFinite(value) || value < 1 || value > 1000) {
      throw validationError("Rate limit max must be between 1 and 1000", {
        rateLimitMax: "Use a value from 1 to 1000",
      });
    }
    values.rateLimitMax = value;
  }
  if (input.rateLimitWindowSeconds !== undefined) {
    const value = Math.trunc(input.rateLimitWindowSeconds);
    if (!Number.isFinite(value) || value < 10 || value > 86400) {
      throw validationError("Rate limit window must be between 10 seconds and 24 hours", {
        rateLimitWindowSeconds: "Use a value from 10 to 86400",
      });
    }
    values.rateLimitWindowSeconds = value;
  }
  if (Object.keys(values).length > 0) values.updatedAt = Date.now();
  return values;
}

export async function listContactForms(db: DrizzleDb): Promise<ContactFormSummary[]> {
  const rows = await db
    .select()
    .from(contactForms)
    .orderBy(desc(contactForms.createdAt))
    .all();
  const [fieldCounts, submissionCounts] = await Promise.all([
    countFieldsByForm(db),
    countSubmissionsByForm(db),
  ]);
  return rows.map((row) => mapSummary(row, fieldCounts, submissionCounts));
}

export async function getContactFormDetail(db: DrizzleDb, id: string): Promise<ContactFormDetail> {
  const row = await findFormById(db, id);
  const [fields, submissions, fieldCounts, submissionCounts] = await Promise.all([
    loadFields(db, id),
    db
      .select()
      .from(contactFormSubmissions)
      .where(eq(contactFormSubmissions.formId, id))
      .orderBy(desc(contactFormSubmissions.createdAt))
      .limit(50)
      .all(),
    countFieldsByForm(db),
    countSubmissionsByForm(db),
  ]);
  return {
    ...mapSummary(row, fieldCounts, submissionCounts),
    fields: fields.map(mapField),
    submissions: submissions.map(mapSubmission),
  };
}

export async function createContactForm(
  db: DrizzleDb,
  input: CreateContactFormInput,
): Promise<ContactFormDetail> {
  const name = input.name.trim();
  if (!name) throw validationError("Name is required", { name: "Name is required" });
  const fields = normalizeFields(input.fields?.length ? input.fields : DEFAULT_FIELDS);
  const now = Date.now();
  const formId = nanoid();
  const publicKey = `cf_${nanoid(24)}`;

  const statements: BatchItem<"sqlite">[] = [
    db.insert(contactForms).values({
      id: formId,
      name,
      publicKey,
      enabled: true,
      rateLimitMax: 5,
      rateLimitWindowSeconds: 60,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  fields.forEach((field, index) => {
    statements.push(
      db.insert(contactFormFields).values({
        id: nanoid(),
        formId,
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        options: JSON.stringify(field.options),
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
      }),
    );
  });
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return getContactFormDetail(db, formId);
}

export async function updateContactForm(
  db: DrizzleDb,
  id: string,
  input: UpdateContactFormInput,
): Promise<ContactFormDetail> {
  await findFormById(db, id);
  const values = validateRateLimitPatch(input);
  if (Object.keys(values).length === 0) return getContactFormDetail(db, id);
  await db.update(contactForms).set(values).where(eq(contactForms.id, id)).run();
  return getContactFormDetail(db, id);
}

export async function setContactFormFields(
  db: DrizzleDb,
  id: string,
  input: SetContactFormFieldsInput,
): Promise<ContactFormDetail> {
  await findFormById(db, id);
  const fields = normalizeFields(input.fields);
  if (fields.length === 0) throw badRequest("A contact form needs at least one field");

  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [
    db.delete(contactFormFields).where(eq(contactFormFields.formId, id)),
  ];
  fields.forEach((field, index) => {
    statements.push(
      db.insert(contactFormFields).values({
        id: nanoid(),
        formId: id,
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        options: JSON.stringify(field.options),
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
      }),
    );
  });
  statements.push(db.update(contactForms).set({ updatedAt: now }).where(eq(contactForms.id, id)));
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return getContactFormDetail(db, id);
}

export async function deleteContactForm(db: DrizzleDb, id: string): Promise<void> {
  const row = await findFormById(db, id);
  await db.delete(contactForms).where(eq(contactForms.id, row.id)).run();
}

function fieldError(field: ContactFormFieldDTO, message: string): never {
  throw validationError(message, { [field.name]: message });
}

function validateSubmissionData(
  fields: ContactFormFieldDTO[],
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field.name];
    const missing = value === undefined || value === null || value === "";
    if (field.required && missing) fieldError(field, "This field is required");
    if (missing) continue;

    if (field.type === "checkbox") {
      if (typeof value !== "boolean") fieldError(field, "Expected a boolean");
      if (field.required && !value) fieldError(field, "This field must be checked");
      data[field.name] = value;
      continue;
    }

    if (field.type === "number") {
      const numberValue = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numberValue)) fieldError(field, "Expected a number");
      data[field.name] = numberValue;
      continue;
    }

    if (typeof value !== "string") fieldError(field, "Expected text");
    const text = value.trim();
    if (field.required && !text) fieldError(field, "This field is required");
    if (!text) continue;

    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      fieldError(field, "Enter a valid email address");
    }
    if (field.type === "select" && !(field.options.choices ?? []).includes(text)) {
      fieldError(field, "Choose one of the allowed options");
    }
    data[field.name] = text;
  }
  return data;
}

export async function submitContactForm(
  db: DrizzleDb,
  publicKey: string,
  rawData: Record<string, unknown>,
  clientIp: string,
  userAgent: string | null,
): Promise<{ submissionId: string }> {
  const form = await findFormByPublicKey(db, publicKey);
  const fields = (await loadFields(db, form.id)).map(mapField);
  if (fields.length === 0) throw conflict("Contact form has no fields configured");

  const ipHash = hashString(`${form.id}:${clientIp || "unknown"}`);
  const since = Date.now() - form.rateLimitWindowSeconds * 1000;
  const recent = await db
    .select({ n: count() })
    .from(contactFormSubmissions)
    .where(
      and(
        eq(contactFormSubmissions.formId, form.id),
        eq(contactFormSubmissions.ipHash, ipHash),
        gte(contactFormSubmissions.createdAt, since),
      ),
    )
    .get();
  if ((recent?.n ?? 0) >= form.rateLimitMax) {
    throw rateLimited("Too many submissions. Try again later.");
  }

  const data = validateSubmissionData(fields, rawData);
  const now = Date.now();
  const submissionId = nanoid();
  await db.insert(contactFormSubmissions).values({
    id: submissionId,
    formId: form.id,
    data: JSON.stringify(data),
    ipHash,
    userAgent: userAgent?.slice(0, 500) ?? null,
    createdAt: now,
  });
  return { submissionId };
}
