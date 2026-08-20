import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";

/**
 * Product adaptation of Beautiful UI's MIT-licensed Approval Card primitive.
 * https://www.beautifului.dev/#approval-card
 */
export function ApprovalCard({
  eyebrow,
  title,
  message,
  titleId,
  messageId,
  children,
  footer,
  onDismiss,
}: {
  eyebrow: string;
  title: string;
  message?: string;
  titleId: string;
  messageId?: string;
  children: ReactNode;
  footer?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <Card
      size="sm"
      className="approval-card mx-auto max-h-[min(30rem,54dvh)] w-full gap-0 overflow-auto py-0"
      data-presentation="approval-card"
    >
      <CardHeader className="approval-card-header grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3.5 pb-2 pt-3.5">
        <small className="sr-only">{eyebrow}</small>
        <h2 className="min-w-0 text-[13px] font-medium leading-relaxed" id={titleId}>{title}</h2>
        {onDismiss && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="approval-card-dismiss -mr-1 -mt-1"
            aria-label="Dismiss request"
            onClick={onDismiss}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2.2} />
          </Button>
        )}
        {message && <p className="col-span-2 m-0 text-[11.5px]/relaxed text-muted-foreground" id={messageId}>{message}</p>}
      </CardHeader>
      <CardContent className="approval-card-content px-3.5 pb-2.5 pt-0">{children}</CardContent>
      {footer && (
        <CardFooter className="approval-card-footer min-h-10 border-t border-border/70 px-2.5 py-0">
          {footer}
        </CardFooter>
      )}
    </Card>
  );
}
