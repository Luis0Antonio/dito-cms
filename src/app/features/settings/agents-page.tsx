import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { useI18n } from "@/app/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { CopyButton } from "@/app/components/common/copy-button";

export function AgentsPage(): React.ReactElement {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");

  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  // Fall back to a visible placeholder so the prompt is copy-pastable even before a key is
  // pasted — the user can drop the real key in afterward.
  const key = apiKey.trim() || t("settings.agents.prompt.keyPlaceholder");

  // Compose the prompt from localized prose + literal commands. The `claude mcp add` line and
  // the raw connection params must never be translated, so they stay as string literals here.
  const promptText = [
    t("settings.agents.prompt.intro", { url: origin }),
    "",
    t("settings.agents.prompt.goal"),
    "",
    `1. ${t("settings.agents.prompt.step1")}`,
    "",
    `   claude mcp add --transport http --scope local dito ${mcpUrl} --header "Authorization: Bearer ${key}"`,
    "",
    `   ${t("settings.agents.prompt.step1Note")}`,
    "",
    `   ${t("settings.agents.prompt.manual")}`,
    `   • Endpoint: ${mcpUrl}`,
    `   • Transport: HTTP (streamable)`,
    `   • Header: Authorization: Bearer ${key}`,
    "",
    `2. ${t("settings.agents.prompt.step2")}`,
    "",
    `   curl -s -X POST ${mcpUrl} -H "Authorization: Bearer ${key}" -H "Accept: application/json, text/event-stream" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    "",
    `3. ${t("settings.agents.prompt.step3")}`,
    "",
    t("settings.agents.prompt.reference", { url: origin }),
  ].join("\n");

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("settings.agents.description")}</p>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="text-base">{t("settings.agents.prompt.title")}</CardTitle>
              <p className="text-sm text-muted-foreground">{t("settings.agents.prompt.description")}</p>
            </div>
            <CopyButton
              value={promptText}
              label={t("settings.agents.copyPrompt")}
              copiedLabel={t("settings.agents.copied")}
              size="sm"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-md space-y-1.5">
            <Label htmlFor="agent-api-key">{t("settings.agents.apiKey.label")}</Label>
            <Input
              id="agent-api-key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("settings.agents.apiKey.placeholder")}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.agents.apiKey.hint")}{" "}
              <Link
                to="/settings/api-keys"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t("settings.agents.apiKey.hintLink")}
              </Link>
              .
            </p>
          </div>

          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
            {promptText}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.agents.how.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>{t("settings.agents.how.item1")}</li>
            <li>{t("settings.agents.how.item2", { url: origin })}</li>
            <li>{t("settings.agents.how.item3")}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
