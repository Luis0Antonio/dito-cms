import { queryOptions } from "@tanstack/react-query";

import { api } from "./client";

import type {
  ContactFormDetail,
  ContactFormFieldInput,
  ContactFormSummary,
  CreateContactFormInput,
  SetContactFormFieldsInput,
  UpdateContactFormInput,
} from "@/shared/api-types";

export const contactFormKeys = {
  all: ["contact-forms"] as const,
  list: () => [...contactFormKeys.all, "list"] as const,
  detail: (id: string) => [...contactFormKeys.all, "detail", id] as const,
};

export const contactFormsListQueryOptions = queryOptions({
  queryKey: contactFormKeys.list(),
  queryFn: async (): Promise<ContactFormSummary[]> => {
    const { forms } = await api.get<{ forms: ContactFormSummary[] }>("/api/admin/contact-forms");
    return forms;
  },
});

export const contactFormDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: contactFormKeys.detail(id),
    queryFn: async (): Promise<ContactFormDetail> => {
      const { form } = await api.get<{ form: ContactFormDetail }>(`/api/admin/contact-forms/${id}`);
      return form;
    },
    enabled: Boolean(id),
    refetchOnMount: "always",
  });

export async function createContactForm(input: CreateContactFormInput): Promise<ContactFormDetail> {
  const { form } = await api.post<{ form: ContactFormDetail }>("/api/admin/contact-forms", input);
  return form;
}

export async function updateContactForm(id: string, input: UpdateContactFormInput): Promise<ContactFormDetail> {
  const { form } = await api.patch<{ form: ContactFormDetail }>(`/api/admin/contact-forms/${id}`, input);
  return form;
}

export async function setContactFormFields(
  id: string,
  fields: ContactFormFieldInput[],
): Promise<ContactFormDetail> {
  const body: SetContactFormFieldsInput = { fields };
  const { form } = await api.put<{ form: ContactFormDetail }>(`/api/admin/contact-forms/${id}/fields`, body);
  return form;
}

export async function deleteContactForm(id: string): Promise<void> {
  await api.delete(`/api/admin/contact-forms/${id}`);
}
