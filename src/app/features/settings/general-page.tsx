import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImageIcon } from "lucide-react";
import { toast } from "sonner";

import {
  projectSettingsQueryOptions,
  settingsKeys,
  updateProjectSettings,
} from "@/app/api/settings";
import { APP_VERSION, MAX_LOGO_BYTES, REPO_URL } from "@/shared/constants";
import type { ProjectSettings } from "@/shared/api-types";
import { useI18n, type Locale } from "@/app/i18n";
import { useTheme, type Theme } from "@/app/lib/theme";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Skeleton } from "@/app/components/ui/skeleton";
import { Switch } from "@/app/components/ui/switch";
import { CopyButton } from "@/app/components/common/copy-button";
import { ErrorState } from "@/app/components/common/error-state";

function UrlRow({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">{value}</code>
        <CopyButton value={value} />
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const LOCALES: { value: Locale; labelKey: "language.es" | "language.en" }[] = [
  { value: "es", labelKey: "language.es" },
  { value: "en", labelKey: "language.en" },
];

const THEMES: { value: Theme; labelKey: "theme.light" | "theme.dark" | "theme.system" }[] = [
  { value: "light", labelKey: "theme.light" },
  { value: "dark", labelKey: "theme.dark" },
  { value: "system", labelKey: "theme.system" },
];

export function GeneralSettingsPage(): React.ReactElement {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(projectSettingsQueryOptions);

  const [name, setName] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (data) {
      setName(data.projectName);
      setLogo(data.logo);
    }
  }, [data]);

  const onLogoFile = (file: File | undefined): void => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > MAX_LOGO_BYTES) {
      toast.error(t("settings.general.logoError"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => toast.error(t("settings.general.logoError"));
    reader.readAsDataURL(file);
  };

  const save = useMutation({
    mutationFn: () => {
      const patch: Partial<ProjectSettings> = {};
      const trimmed = name.trim();
      if (trimmed && trimmed !== data?.projectName) patch.projectName = trimmed;
      if (logo !== (data?.logo ?? null)) patch.logo = logo;
      return updateProjectSettings(patch);
    },
    onSuccess: (result) => {
      queryClient.setQueryData<ProjectSettings>(settingsKeys.all, result);
      setName(result.projectName);
      setLogo(result.logo);
      toast.success(t("settings.general.saved"));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("settings.general.saveError")),
  });

  // The Store toggle saves immediately (no save button). Writing the fresh settings back into
  // the cache makes the sidebar nav and route guards (which read the same query) react at once.
  const toggleStore = useMutation({
    mutationFn: (enabled: boolean) => updateProjectSettings({ commerceEnabled: enabled }),
    onSuccess: (result) => {
      queryClient.setQueryData<ProjectSettings>(settingsKeys.all, result);
      toast.success(t("settings.general.saved"));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("settings.general.saveError")),
  });

  const origin = window.location.origin;
  const deliveryBaseUrl = `${origin}/api/v1`;
  const mcpUrl = `${origin}/mcp`;
  const nameDirty = data ? name.trim() !== data.projectName && name.trim() !== "" : false;
  const logoDirty = data ? logo !== data.logo : false;
  const dirty = nameDirty || logoDirty;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.general.project")}</CardTitle>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Skeleton className="h-10 w-full max-w-sm" />
          ) : isError ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : (
            <form
              className="flex max-w-sm flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (dirty) save.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label>{t("settings.general.logo")}</Label>
                <div className="flex items-center gap-3">
                  <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                    {logo ? (
                      <img src={logo} alt="" className="size-full object-contain" />
                    ) : (
                      <ImageIcon className="size-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        onLogoFile(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileRef.current?.click()}
                    >
                      {logo ? t("settings.general.logoChange") : t("settings.general.logoUpload")}
                    </Button>
                    {logo ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setLogo(null)}>
                        {t("settings.general.logoRemove")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{t("settings.general.logoHint")}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="project-name">{t("settings.general.projectName")}</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("settings.general.projectNamePlaceholder")}
                  maxLength={60}
                />
                <p className="text-xs text-muted-foreground">{t("settings.general.projectNameHint")}</p>
              </div>
              <div>
                <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
                  {save.isPending ? t("settings.general.saving") : t("settings.general.save")}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.general.connections")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <UrlRow
            label={t("settings.general.deliveryApi")}
            value={deliveryBaseUrl}
            hint={t("settings.general.deliveryApiHint")}
          />
          <UrlRow
            label={t("settings.general.mcpEndpoint")}
            value={mcpUrl}
            hint={
              <>
                {t("settings.general.mcpEndpointHint")}{" "}
                <Link to="/settings/api-keys" className="underline underline-offset-2 hover:text-foreground">
                  {t("settings.general.mcpEndpointHintLink")}
                </Link>
                .
              </>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.general.language")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm space-y-1.5">
            <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
              <SelectTrigger id="language-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCALES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {t(l.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("settings.general.languageHint")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.general.theme")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm space-y-1.5">
            <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <SelectTrigger id="theme-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {t(o.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("settings.general.themeHint")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.general.store")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex max-w-xl items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="store-enabled">{t("settings.general.storeEnable")}</Label>
              <p className="text-xs text-muted-foreground">{t("settings.general.storeHint")}</p>
            </div>
            <Switch
              id="store-enabled"
              checked={data?.commerceEnabled ?? false}
              onCheckedChange={(v) => toggleStore.mutate(v)}
              disabled={!data || toggleStore.isPending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.general.about")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("settings.general.version")}</span>
            <span className="font-medium">{APP_VERSION}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("settings.general.documentation")}</span>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-2 hover:text-foreground"
            >
              {t("settings.general.github")}
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
