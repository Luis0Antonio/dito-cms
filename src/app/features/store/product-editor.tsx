import { useState } from "react";
import { useForm, type FieldValues } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ImageIcon, Trash2Icon, XIcon } from "lucide-react";

import { FieldInput } from "../entries/inputs/field-input";
import { toEntryData, toFormValues } from "../entries/form-values";
import { MediaPickerDialog } from "../media/media-picker-dialog";

import {
  createProduct,
  deleteProduct,
  storeKeys,
  updateProduct,
  type ProductWriteBody,
} from "@/app/api/store";
import { isApiError } from "@/app/api/client";
import { useI18n } from "@/app/i18n";
import { slugify } from "@/shared/slug";
import type { CategorySummary, FieldDTO, ProductDetail, MediaDTO } from "@/shared/api-types";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/app/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { ConfirmDialog } from "@/app/components/common/confirm-dialog";
import { useUnsavedChangesGuard } from "@/app/hooks/use-unsaved-changes-guard";

// Maps a server validation key onto the RHF field name (core fields are `_`-prefixed; custom
// fields keep their bare API name, which can never start with `_`).
const CORE_ERROR_TO_FIELD: Record<string, string> = {
  name: "_name",
  slug: "_slug",
  description: "_description",
  priceAmount: "_price",
  sku: "_sku",
  stock: "_stock",
  categoryId: "_category",
  status: "_status",
};

interface ProductEditorProps {
  schema: FieldDTO[];
  categories: CategorySummary[];
  /** null → authoring a new product. */
  product: ProductDetail | null;
}

export function ProductEditor({ schema, categories, product }: ProductEditorProps): React.ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = product === null;

  const form = useForm<FieldValues>({
    defaultValues: {
      _name: product?.name ?? "",
      _slug: product?.slug ?? "",
      _description: product?.description ?? "",
      _price: product?.priceAmount ?? 0,
      _sku: product?.sku ?? "",
      _stock: product?.stock ?? null,
      _status: product?.status ?? "draft",
      _category: product?.categoryId ?? "",
      ...toFormValues(schema, product?.customData ?? {}),
    },
  });
  const [images, setImages] = useState<MediaDTO[]>(product?.images ?? []);
  const [imagesDirty, setImagesDirty] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "delete">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [slugEdited, setSlugEdited] = useState(!isNew);

  const isDirty = form.formState.isDirty || imagesDirty;
  useUnsavedChangesGuard(isDirty && busy === null);

  const applyErrors = (fieldErrors?: Record<string, string>): boolean => {
    if (!fieldErrors) return false;
    let mapped = false;
    for (const [key, message] of Object.entries(fieldErrors)) {
      const target = CORE_ERROR_TO_FIELD[key] ?? (schema.some((f) => f.name === key) ? key : null);
      if (target) {
        form.setError(target, { message });
        mapped = true;
      } else {
        toast.error(message);
      }
    }
    return mapped;
  };

  const addImage = (media: MediaDTO): void => {
    setImages((prev) => (prev.some((m) => m.id === media.id) ? prev : [...prev, media]));
    setImagesDirty(true);
  };
  const removeImage = (id: string): void => {
    setImages((prev) => prev.filter((m) => m.id !== id));
    setImagesDirty(true);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setBusy("save");
    try {
      const stockRaw = values._stock;
      const body: ProductWriteBody = {
        name: String(values._name ?? "").trim(),
        slug: String(values._slug ?? "").trim(),
        description: String(values._description ?? "").trim() || null,
        priceAmount: typeof values._price === "number" ? values._price : Number(values._price) || 0,
        sku: String(values._sku ?? "").trim() || null,
        stock: stockRaw === "" || stockRaw === null || stockRaw === undefined ? null : Number(stockRaw),
        status: values._status,
        categoryId: values._category ? String(values._category) : null,
        customData: toEntryData(schema, values) as Record<string, unknown>,
        imageIds: images.map((m) => m.id),
      };
      const saved = isNew ? await createProduct(body) : await updateProduct(product.slug, body);
      queryClient.setQueryData(storeKeys.product(saved.slug), saved);
      void queryClient.invalidateQueries({ queryKey: storeKeys.products() });
      void queryClient.invalidateQueries({ queryKey: storeKeys.categories() });
      form.reset(values);
      setImagesDirty(false);
      toast.success(isNew ? t("store.editor.created") : t("store.editor.saved"));
      if (isNew || saved.slug !== product.slug) {
        void navigate({ to: "/store/products/$slug", params: { slug: saved.slug } });
      }
    } catch (e) {
      if (isApiError(e) && applyErrors(e.fieldErrors)) {
        toast.error(t("store.editor.fieldsError"));
      } else {
        toast.error(isApiError(e) ? e.message : t("store.editor.saveError"));
      }
    } finally {
      setBusy(null);
    }
  });

  const doDelete = async (): Promise<void> => {
    if (!product) return;
    setBusy("delete");
    try {
      await deleteProduct(product.slug);
      void queryClient.invalidateQueries({ queryKey: storeKeys.products() });
      void queryClient.invalidateQueries({ queryKey: storeKeys.categories() });
      form.reset(form.getValues());
      setImagesDirty(false);
      toast.success(t("store.editor.deleted"));
      void navigate({ to: "/store/products" });
    } catch (e) {
      toast.error(isApiError(e) ? e.message : t("store.editor.deleteError"));
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("store.editor.section.details")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("store.editor.name")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={(field.value as string) ?? ""}
                      onChange={(e) => {
                        field.onChange(e);
                        if (isNew && !slugEdited) form.setValue("_slug", slugify(e.target.value));
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="_slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("store.editor.slug")}</FormLabel>
                  <FormControl>
                    <Input
                      className="font-mono"
                      {...field}
                      value={(field.value as string) ?? ""}
                      onChange={(e) => {
                        setSlugEdited(true);
                        field.onChange(e);
                      }}
                    />
                  </FormControl>
                  <FormDescription>{t("store.editor.slugHint")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="_description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("store.editor.description")}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} value={(field.value as string) ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("store.editor.section.pricing")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="_price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("store.editor.price")}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        value={field.value === undefined || field.value === null ? "" : String(field.value)}
                        onChange={(e) => field.onChange(e.target.value === "" ? 0 : e.target.valueAsNumber)}
                      />
                    </FormControl>
                    <FormDescription>{t("store.editor.priceHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="_status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("store.editor.status")}</FormLabel>
                    <Select value={(field.value as string) ?? "draft"} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="draft">{t("store.status.draft")}</SelectItem>
                        <SelectItem value="active">{t("store.status.active")}</SelectItem>
                        <SelectItem value="archived">{t("store.status.archived")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="_sku"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("store.editor.sku")}</FormLabel>
                    <FormControl>
                      <Input className="font-mono" {...field} value={(field.value as string) ?? ""} />
                    </FormControl>
                    <FormDescription>{t("store.editor.skuHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="_stock"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("store.editor.stock")}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        value={field.value === undefined || field.value === null ? "" : String(field.value)}
                        onChange={(e) => field.onChange(e.target.value === "" ? null : e.target.valueAsNumber)}
                      />
                    </FormControl>
                    <FormDescription>{t("store.editor.stockHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="_category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("store.editor.category")}</FormLabel>
                  <Select
                    value={(field.value as string) || "__none__"}
                    onValueChange={(v) => field.onChange(v === "__none__" ? "" : v)}
                  >
                    <FormControl>
                      <SelectTrigger className="max-w-sm">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="__none__">{t("store.editor.categoryNone")}</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("store.editor.section.images")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {images.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("store.editor.noImages")}</p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {images.map((m) => (
                  <div key={m.id} className="group relative size-24 overflow-hidden rounded-md border bg-muted">
                    <img src={m.url} alt={m.alt ?? ""} className="size-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeImage(m.id)}
                      aria-label={t("store.editor.removeImage")}
                      className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    >
                      <XIcon className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
              <ImageIcon className="size-4" />
              {t("store.editor.addImage")}
            </Button>
          </CardContent>
        </Card>

        {schema.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("store.editor.section.custom")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {schema.map((field) => (
                <FieldInput key={field.id} control={form.control} field={field} />
              ))}
            </CardContent>
          </Card>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy !== null || (!isNew && !isDirty)}>
            {busy === "save" ? t("store.editor.saving") : t("store.editor.save")}
          </Button>
          {!isNew ? (
            <Button
              type="button"
              variant="outline"
              className="text-muted-foreground hover:text-destructive"
              disabled={busy !== null}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon className="size-4" />
              {t("store.editor.delete")}
            </Button>
          ) : null}
        </div>
      </form>

      <MediaPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} kind="image" onSelect={addImage} />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(false)}
        title={t("store.editor.deleteConfirm.title")}
        description={t("store.editor.deleteConfirm.description")}
        confirmLabel={t("store.editor.deleteConfirm.confirm")}
        destructive
        loading={busy === "delete"}
        onConfirm={() => void doDelete()}
      />
    </Form>
  );
}
