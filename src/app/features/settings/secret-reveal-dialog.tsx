import { TriangleAlertIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Button } from "@/app/components/ui/button";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { CopyButton } from "@/app/components/common/copy-button";

interface SecretRevealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  secret: string;
  /** Extra non-secret context, e.g. the user's email. */
  fields?: { label: string; value: string }[];
  warning?: string;
}

export function SecretRevealDialog({
  open,
  onOpenChange,
  title,
  description,
  secret,
  fields,
  warning = "Copy this now — it won't be shown again.",
}: SecretRevealDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          {fields?.map((f) => (
            <div key={f.label} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{f.label}</span>
              <span className="font-medium">{f.value}</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">{secret}</code>
            <CopyButton value={secret} />
          </div>
          <Alert className="border-warning/40 text-foreground">
            <TriangleAlertIcon className="size-4 text-warning" />
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
