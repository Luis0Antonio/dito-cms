import {
  FileTextIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  Link2Icon,
  ListIcon,
  ToggleLeftIcon,
  TypeIcon,
  VideoIcon,
  type LucideIcon,
} from "lucide-react";

import { type FieldType } from "@/shared/field-types";

// Client-only icon map for the 9 field types. Labels/descriptions live in the
// isomorphic field-types.ts (which can't import lucide).
export const FIELD_TYPE_ICONS: Record<FieldType, LucideIcon> = {
  text: TypeIcon,
  rich_text: FileTextIcon,
  number: HashIcon,
  boolean: ToggleLeftIcon,
  picture: ImageIcon,
  video: VideoIcon,
  link: LinkIcon,
  reference: Link2Icon,
  select: ListIcon,
};
