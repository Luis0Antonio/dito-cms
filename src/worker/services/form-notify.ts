import type { SubmittedContactForm } from "./contact-forms";

// Emails a form's recipients about a new submission through Cloudflare Email Service (the
// `EMAIL` send_email binding). Optional, like CLOUDINARY_URL: with no FORMS_EMAIL_FROM (or no
// recipients on the form) nothing is sent. The body is plain text on purpose — every value in
// it is visitor input.

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return String(value);
}

export async function notifySubmission(
  env: Env,
  origin: string,
  submission: SubmittedContactForm,
): Promise<void> {
  const { form, fields, data } = submission;
  const to = form.notifyEmails ? form.notifyEmails.split(",") : [];
  if (to.length === 0) return;
  if (!env.FORMS_EMAIL_FROM) {
    console.warn(`[forms] "${form.name}" has recipients but FORMS_EMAIL_FROM is not set`);
    return;
  }

  const lines = fields
    .filter((field) => data[field.name] !== undefined)
    .map((field) => `${field.label}:\n${formatValue(data[field.name])}\n`);
  const replyTo = fields.find((field) => field.type === "email" && typeof data[field.name] === "string");

  try {
    await env.EMAIL.send({
      from: env.FORMS_EMAIL_FROM,
      to,
      replyTo: replyTo ? (data[replyTo.name] as string) : undefined,
      subject: `Nuevo mensaje: ${form.name}`,
      text: [...lines, "—", `Ver todos los mensajes: ${origin}/contact-forms`].join("\n"),
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unknown";
    console.error(`[forms] notification for "${form.name}" failed: ${code} ${(err as Error).message}`);
  }
}
