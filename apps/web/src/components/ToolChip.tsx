import type { ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * Product adaptation of Beautiful UI's MIT-licensed Tool Chips primitive.
 * https://www.beautifului.dev/#tool-chips
 */
export function ToolChip({
  title,
  detail,
  appearance,
  status,
  icon,
  statusIcon,
  detailClassName,
  entering = false,
  children,
}: {
  title: string;
  detail: string;
  appearance: string;
  status: string;
  icon: ReactNode;
  statusIcon: ReactNode;
  detailClassName?: string;
  entering?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible className={`tool-chip tool-chip--${status} tool-chip--${appearance}${entering ? " timeline-entry--entering" : ""}`}>
      <CollapsibleTrigger className="tool-chip-trigger">
        <span className="tool-chip-icon">{icon}</span>
        <span className="tool-chip-title">{title}</span>
        <span className={`tool-chip-detail${detailClassName ? ` ${detailClassName}` : ""}`} title={detail}>{detail}</span>
        <span className="tool-chip-status">{statusIcon}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="tool-chip-content" forceMount>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
