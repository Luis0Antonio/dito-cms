import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import {
  orderHookActivityQueryOptions,
  storeSettingsKeys,
  storeSettingsQueryOptions,
  testOrderHook,
  updateStoreSettings,
} from "@/app/api/store-settings";
import type { StoreSettings } from "@/shared/api-types";
import { useI18n } from "@/app/i18n";
import type { TranslationKey } from "@/app/i18n/translations/es";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Switch } from "@/app/components/ui/switch";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { ErrorState } from "@/app/components/common/error-state";
import { formatDateTime, formatRelativeTime } from "@/app/lib/format";
import { cn } from "@/app/lib/utils";

// Store settings: currency, the Culqi gateway credentials, and the merchant order-hook. Payment
// and hook secrets are write-only — the server returns only whether each is configured, so we
// seed the safe fields and reset the secret inputs (mirrors the deploy-hook settings page).

/** Persist one settings fragment through the shared cache; toast on success/failure. */
function useSaveSettings() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateStoreSettings,
    onSuccess: (result) => {
      queryClient.setQueryData<StoreSettings>(storeSettingsKeys.all, result);
      toast.success(t("store.settings.saved"));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("store.settings.saveError")),
  });
}

// --- currency ----------------------------------------------------------------

function CurrencyCard({ settings }: { settings: StoreSettings }): React.ReactElement {
  const { t } = useI18n();
  const save = useSaveSettings();
  const [currency, setCurrency] = useState(settings.currency);

  useEffect(() => setCurrency(settings.currency), [settings.currency]);

  const dirty = currency.trim() !== settings.currency && currency.trim() !== "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("store.settings.general.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("store.settings.general.description")}</p>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-xl space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate({ currency: currency.trim() });
          }}
        >
          <Label htmlFor="store-currency">{t("store.settings.general.currency")}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="store-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
              className="w-28 font-mono uppercase"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
              {save.isPending ? t("store.settings.saving") : t("store.settings.save")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("store.settings.general.currencyHint")}</p>
        </form>
      </CardContent>
    </Card>
  );
}

// --- Culqi -------------------------------------------------------------------

function CulqiCard({ settings }: { settings: StoreSettings }): React.ReactElement {
  const { t } = useI18n();
  const save = useSaveSettings();
  const culqi = settings.culqi;

  const [enabled, setEnabled] = useState(culqi.enabled);
  const [publicKey, setPublicKey] = useState(culqi.publicKey);
  const [editingSecret, setEditingSecret] = useState(!culqi.secretKeyConfigured);
  const [secretKey, setSecretKey] = useState("");

  useEffect(() => {
    setEnabled(culqi.enabled);
    setPublicKey(culqi.publicKey);
    setSecretKey("");
    setEditingSecret(!culqi.secretKeyConfigured);
  }, [culqi.enabled, culqi.publicKey, culqi.secretKeyConfigured]);

  const dirty =
    enabled !== culqi.enabled ||
    publicKey !== culqi.publicKey ||
    (editingSecret && secretKey.trim() !== "");

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!dirty) return;
    const patch: { enabled?: boolean; publicKey?: string; secretKey?: string } = {};
    if (enabled !== culqi.enabled) patch.enabled = enabled;
    if (publicKey !== culqi.publicKey) patch.publicKey = publicKey.trim();
    if (editingSecret && secretKey.trim()) patch.secretKey = secretKey.trim();
    save.mutate({ culqi: patch });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("store.settings.culqi.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("store.settings.culqi.description")}</p>
      </CardHeader>
      <CardContent>
        <form className="max-w-xl space-y-5" onSubmit={submit}>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="culqi-enabled">{t("store.settings.culqi.enable")}</Label>
              <p className="text-xs text-muted-foreground">{t("store.settings.culqi.enableHint")}</p>
            </div>
            <Switch id="culqi-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="culqi-public">{t("store.settings.culqi.publicKey")}</Label>
            <Input
              id="culqi-public"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder={t("store.settings.culqi.publicKeyPlaceholder")}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">{t("store.settings.culqi.publicKeyHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="culqi-secret">{t("store.settings.culqi.secretKey")}</Label>
            {culqi.secretKeyConfigured && !editingSecret ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                  {t("store.settings.culqi.secretConfigured")}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingSecret(true);
                    setSecretKey("");
                  }}
                >
                  {t("store.settings.replace")}
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Input
                  id="culqi-secret"
                  type="password"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder={t("store.settings.culqi.secretKeyPlaceholder")}
                  className="font-mono text-xs"
                  autoComplete="off"
                />
                {culqi.secretKeyConfigured ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() => {
                      setEditingSecret(false);
                      setSecretKey("");
                    }}
                  >
                    {t("store.settings.cancel")}
                  </button>
                ) : null}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("store.settings.culqi.secretKeyHint")}</p>
          </div>

          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? t("store.settings.saving") : t("store.settings.save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// --- order hook --------------------------------------------------------------

function OrderHookCard({ settings }: { settings: StoreSettings }): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useSaveSettings();
  const hook = settings.orderHook;

  const [enabled, setEnabled] = useState(hook.enabled);
  const [editingUrl, setEditingUrl] = useState(!hook.configured);
  const [url, setUrl] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");

  useEffect(() => {
    setEnabled(hook.enabled);
    setHeaderName(hook.authHeaderName ?? "");
    setHeaderValue("");
    setUrl("");
    setEditingUrl(!hook.configured);
    if (hook.hasAuthHeader) setAdvancedOpen(true);
  }, [hook.enabled, hook.configured, hook.hasAuthHeader, hook.authHeaderName]);

  const dirty =
    enabled !== hook.enabled ||
    (editingUrl && url.trim() !== "") ||
    headerName.trim() !== (hook.authHeaderName ?? "") ||
    headerValue.trim() !== "";

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!dirty) return;
    const patch: { url?: string; enabled?: boolean; authHeaderName?: string | null; authHeaderValue?: string } = {
      enabled,
    };
    if (editingUrl && url.trim()) patch.url = url.trim();
    if (headerName.trim() !== (hook.authHeaderName ?? "")) patch.authHeaderName = headerName.trim();
    if (headerValue.trim()) patch.authHeaderValue = headerValue.trim();
    save.mutate({ orderHook: patch });
  };

  const test = useMutation({
    mutationFn: testOrderHook,
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(t("store.settings.orderHook.testSuccess", { status: result.status ?? 200 }));
      } else {
        toast.error(t("store.settings.orderHook.testError", { error: result.error ?? "" }));
      }
      void queryClient.invalidateQueries({ queryKey: storeSettingsKeys.orderHookActivity });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : t("store.settings.orderHook.testError", { error: "" })),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("store.settings.orderHook.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("store.settings.orderHook.description")}</p>
      </CardHeader>
      <CardContent>
        <form className="max-w-xl space-y-5" onSubmit={submit}>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="order-hook-enabled">{t("store.settings.orderHook.enable")}</Label>
              <p className="text-xs text-muted-foreground">{t("store.settings.orderHook.enableHint")}</p>
            </div>
            <Switch id="order-hook-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="order-hook-url">{t("store.settings.orderHook.url")}</Label>
            {hook.configured && !editingUrl ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  {hook.urlPreview}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingUrl(true);
                    setUrl("");
                  }}
                >
                  {t("store.settings.replace")}
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Input
                  id="order-hook-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={t("store.settings.orderHook.urlPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
                {hook.configured ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() => {
                      setEditingUrl(false);
                      setUrl("");
                    }}
                  >
                    {t("store.settings.cancel")}
                  </button>
                ) : null}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("store.settings.orderHook.urlHint")}</p>
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRightIcon className={cn("size-4 transition-transform", advancedOpen && "rotate-90")} />
              {t("store.settings.orderHook.advanced")}
            </button>
            {advancedOpen ? (
              <div className="space-y-3 border-l pl-4">
                <p className="text-xs text-muted-foreground">{t("store.settings.orderHook.advancedHint")}</p>
                <div className="space-y-1.5">
                  <Label htmlFor="order-hook-header-name">{t("store.settings.orderHook.headerName")}</Label>
                  <Input
                    id="order-hook-header-name"
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                    placeholder={t("store.settings.orderHook.headerNamePlaceholder")}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="order-hook-header-value">{t("store.settings.orderHook.headerValue")}</Label>
                  <Input
                    id="order-hook-header-value"
                    type="password"
                    value={headerValue}
                    onChange={(e) => setHeaderValue(e.target.value)}
                    placeholder={hook.hasAuthHeader ? "••••••••" : t("store.settings.orderHook.headerValuePlaceholder")}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">{t("store.settings.orderHook.headerValueHint")}</p>
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
              {save.isPending ? t("store.settings.saving") : t("store.settings.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={test.isPending || !hook.enabled || !hook.configured}
              onClick={() => test.mutate()}
            >
              {test.isPending ? t("store.settings.orderHook.testing") : t("store.settings.orderHook.test")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --- order hook activity -----------------------------------------------------

const EVENT_LABEL_KEYS: Record<string, TranslationKey> = {
  "order.paid": "store.settings.orderHook.activity.event.orderPaid",
  test: "store.settings.orderHook.activity.event.test",
};

function OrderHookActivityCard(): React.ReactElement {
  const { t } = useI18n();
  const activity = useQuery(orderHookActivityQueryOptions);

  const eventLabel = (event: string): string => {
    const key = EVENT_LABEL_KEYS[event];
    return key ? t(key) : event;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("store.settings.orderHook.activity.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("store.settings.orderHook.activity.description")}</p>
      </CardHeader>
      <CardContent>
        {activity.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : activity.isError ? (
          <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />
        ) : activity.data.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("store.settings.orderHook.activity.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("store.settings.orderHook.activity.colEvent")}</TableHead>
                <TableHead>{t("store.settings.orderHook.activity.colUrl")}</TableHead>
                <TableHead>{t("store.settings.orderHook.activity.colStatus")}</TableHead>
                <TableHead className="text-right">{t("store.settings.orderHook.activity.colTime")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activity.data.deliveries.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <div className="font-medium">{eventLabel(d.event)}</div>
                    {d.detail ? <div className="text-xs text-muted-foreground">{d.detail}</div> : null}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-muted-foreground">{d.urlPreview}</code>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      {d.ok ? (
                        <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                      ) : (
                        <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
                      )}
                      <span
                        className={cn("max-w-[16rem] truncate", !d.ok && "text-destructive")}
                        title={d.error ?? undefined}
                      >
                        {d.ok ? `HTTP ${d.status ?? ""}`.trim() : (d.error ?? t("store.settings.orderHook.statusFailed"))}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-right text-xs text-muted-foreground"
                    title={formatDateTime(d.firedAt)}
                  >
                    {formatRelativeTime(d.firedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// --- page --------------------------------------------------------------------

export function StoreSettingsPage(): React.ReactElement {
  const { data, isPending, isError, error, refetch } = useQuery(storeSettingsQueryOptions);

  if (isPending) return <Skeleton className="h-96 w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-6">
      <CurrencyCard settings={data} />
      <CulqiCard settings={data} />
      <OrderHookCard settings={data} />
      <OrderHookActivityCard />
    </div>
  );
}
