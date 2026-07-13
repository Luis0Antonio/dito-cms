import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";

import { applyImport, exportProject, previewImport } from "@/app/api/backup";
import { collectionsKeys } from "@/app/api/collections";
import type {
  ExportDocument,
  ImportPreview,
  ImportResolution,
} from "@/shared/api-types";
import { useI18n } from "@/app/i18n";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Label } from "@/app/components/ui/label";
import { Switch } from "@/app/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { ConfirmDialog } from "@/app/components/common/confirm-dialog";

/** Trigger a browser download of `data` as a pretty-printed JSON file. */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function ExportCard(): React.ReactElement {
  const { t } = useI18n();
  const [includeData, setIncludeData] = useState(false);

  const run = useMutation({
    mutationFn: () => exportProject(includeData),
    onSuccess: (doc) => {
      const date = new Date().toISOString().slice(0, 10);
      downloadJson(`dito-export-${date}.json`, doc);
      toast.success(t("settings.importExport.export.success"));
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : t("settings.importExport.export.error")),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("settings.importExport.export.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("settings.importExport.export.description")}</p>
        <div className="flex items-center gap-3">
          <Switch id="include-data" checked={includeData} onCheckedChange={setIncludeData} />
          <div className="space-y-0.5">
            <Label htmlFor="include-data">{t("settings.importExport.export.includeData")}</Label>
            <p className="text-xs text-muted-foreground">{t("settings.importExport.export.includeDataHint")}</p>
          </div>
        </div>
        <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
          <DownloadIcon className="size-4" />
          {run.isPending ? t("settings.importExport.export.exporting") : t("settings.importExport.export.button")}
        </Button>
      </CardContent>
    </Card>
  );
}

function ImportCard(): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [doc, setDoc] = useState<ExportDocument | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ImportResolution>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);

  const reset = (): void => {
    setDoc(null);
    setPreview(null);
    setResolutions({});
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const previewMutation = useMutation({
    mutationFn: (parsed: ExportDocument) => previewImport(parsed),
    onSuccess: (result, parsed) => {
      setDoc(parsed);
      setPreview(result);
      // Default every conflicting collection to "skip".
      const defaults: Record<string, ImportResolution> = {};
      for (const c of result.collections) {
        if (c.status === "conflict") defaults[c.slug] = "skip";
      }
      setResolutions(defaults);
    },
    onError: (e) => {
      reset();
      toast.error(e instanceof Error ? e.message : t("settings.importExport.import.previewError"));
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      if (!doc) throw new Error(t("settings.importExport.import.previewError"));
      return applyImport({ document: doc, resolutions });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: collectionsKeys.all });
      toast.success(
        t("settings.importExport.import.success", {
          created: result.created.length,
          renamed: result.renamed.length,
          overwritten: result.overwritten.length,
          skipped: result.skipped.length,
        }),
      );
      if (result.unresolvedReferences > 0) {
        toast.warning(
          t("settings.importExport.import.unresolvedRefs", { count: result.unresolvedReferences }),
        );
      }
      reset();
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : t("settings.importExport.import.error")),
  });

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as ExportDocument;
        previewMutation.mutate(parsed);
      } catch {
        reset();
        toast.error(t("settings.importExport.import.parseError"));
      }
    };
    reader.onerror = () => toast.error(t("settings.importExport.import.parseError"));
    reader.readAsText(file);
  };

  const hasOverwrite = Object.values(resolutions).some((r) => r === "overwrite");

  const startImport = (): void => {
    if (hasOverwrite) setConfirmOpen(true);
    else applyMutation.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("settings.importExport.import.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("settings.importExport.import.description")}</p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={onFileChange}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
        />

        {previewMutation.isPending ? (
          <p className="text-sm text-muted-foreground">{t("settings.importExport.import.analyzing")}</p>
        ) : null}

        {preview ? (
          preview.collections.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.importExport.import.empty")}</p>
          ) : (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("settings.importExport.import.table.collection")}</TableHead>
                      <TableHead>{t("settings.importExport.import.table.status")}</TableHead>
                      <TableHead className="text-right">{t("settings.importExport.import.table.fields")}</TableHead>
                      <TableHead className="text-right">{t("settings.importExport.import.table.entries")}</TableHead>
                      <TableHead>{t("settings.importExport.import.table.resolution")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.collections.map((c) => (
                      <TableRow key={c.slug}>
                        <TableCell className="font-medium">
                          {c.name}
                          <span className="ml-1.5 font-mono text-xs text-muted-foreground">{c.slug}</span>
                        </TableCell>
                        <TableCell>
                          {c.status === "conflict" ? (
                            <Badge variant="secondary">{t("settings.importExport.import.status.conflict")}</Badge>
                          ) : (
                            <Badge variant="outline">{t("settings.importExport.import.status.new")}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">{c.fieldCount}</TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {preview.includesData ? c.entryCount : "—"}
                        </TableCell>
                        <TableCell>
                          {c.status === "conflict" ? (
                            <Select
                              value={resolutions[c.slug] ?? "skip"}
                              onValueChange={(v) =>
                                setResolutions((prev) => ({ ...prev, [c.slug]: v as ImportResolution }))
                              }
                            >
                              <SelectTrigger className="h-8 w-32">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="skip">{t("settings.importExport.import.resolution.skip")}</SelectItem>
                                <SelectItem value="rename">{t("settings.importExport.import.resolution.rename")}</SelectItem>
                                <SelectItem value="overwrite">{t("settings.importExport.import.resolution.overwrite")}</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {preview.hasReferences ? (
                <p
                  className={
                    preview.version < 2
                      ? "rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {preview.version < 2
                    ? t("settings.importExport.import.refsNote.v1")
                    : t("settings.importExport.import.refsNote.v2")}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={startImport} disabled={applyMutation.isPending}>
                  <UploadIcon className="size-4" />
                  {applyMutation.isPending
                    ? t("settings.importExport.import.importing")
                    : t("settings.importExport.import.button")}
                </Button>
                <Button size="sm" variant="ghost" onClick={reset} disabled={applyMutation.isPending}>
                  {t("settings.importExport.import.clear")}
                </Button>
              </div>
            </>
          )
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("settings.importExport.import.confirm.title")}
        description={t("settings.importExport.import.confirm.description")}
        confirmLabel={t("settings.importExport.import.confirm.button")}
        destructive
        loading={applyMutation.isPending}
        onConfirm={() => {
          setConfirmOpen(false);
          applyMutation.mutate();
        }}
      />
    </Card>
  );
}

export function ImportExportPage(): React.ReactElement {
  return (
    <div className="space-y-6">
      <ExportCard />
      <ImportCard />
    </div>
  );
}
