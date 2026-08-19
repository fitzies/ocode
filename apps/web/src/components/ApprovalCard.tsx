import type { ReactNode } from "react";

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
}: {
  eyebrow: string;
  title: string;
  message?: string;
  titleId: string;
  messageId?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card
      size="sm"
      className="approval-card mx-auto max-h-[min(30rem,54dvh)] w-full gap-0 overflow-auto py-0"
      data-presentation="approval-card"
    >
      <CardHeader className="approval-card-header sticky top-0 z-10 gap-1 border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
        <small className="text-[0.6875rem] leading-normal text-muted-foreground">{eyebrow}</small>
        <h2 className="text-[13px] font-medium leading-relaxed" id={titleId}>{title}</h2>
        {message && <p className="m-0 text-xs/relaxed text-muted-foreground" id={messageId}>{message}</p>}
      </CardHeader>
      <CardContent className="px-4 py-3">{children}</CardContent>
      {footer && (
        <CardFooter className="approval-card-footer sticky bottom-0 min-h-10 border-t border-border bg-card/95 px-3 py-0 backdrop-blur">
          {footer}
        </CardFooter>
      )}
    </Card>
  );
}
