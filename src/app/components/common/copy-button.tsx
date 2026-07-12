import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";

interface CopyButtonProps {
  value: string;
  label?: string;
  /** Text shown in place of `label` for the ~1.5s after a successful copy. Defaults to "Copied". */
  copiedLabel?: string;
  className?: string;
  size?: "sm" | "default" | "icon";
  variant?: "outline" | "ghost" | "secondary" | "default";
}

export function CopyButton({
  value,
  label,
  copiedLabel = "Copied",
  className,
  size = "icon",
  variant = "outline",
}: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) — silently ignore */
    }
  };

  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <Button type="button" variant={variant} size={size} onClick={copy} className={cn(className)}>
      <Icon className={cn("size-4", copied && "text-success")} />
      {label ? <span>{copied ? copiedLabel : label}</span> : null}
    </Button>
  );
}
