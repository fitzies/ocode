import { ArrowRight02Icon, GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export interface HandoffPresentation {
  direction: "incoming" | "outgoing";
  sourceSessionId: string;
  targetSessionId: string;
}

export function HandoffCard({
  handoff,
  sourceTitle,
  targetTitle,
  onOpenSession,
}: {
  handoff: HandoffPresentation;
  sourceTitle: string;
  targetTitle: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const incoming = handoff.direction === "incoming";
  const relatedSessionId = incoming ? handoff.sourceSessionId : handoff.targetSessionId;
  const relatedTitle = incoming ? sourceTitle : targetTitle;

  return (
    <Card size="sm" className="handoff-card py-0" data-presentation="handoff-card">
      <CardContent className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2.5">
        <span className="handoff-card-icon" aria-hidden="true">
          <HugeiconsIcon icon={GitPullRequestIcon} strokeWidth={2} className="size-4" />
        </span>
        <span className="grid min-w-0 gap-0.5">
          <strong className="text-xs font-medium">{incoming ? "Continued from another thread" : "Handoff created"}</strong>
          <span className="truncate text-[0.6875rem] text-muted-foreground">{relatedTitle}</span>
        </span>
        {onOpenSession && (
          <Button type="button" variant="outline" size="xs" onClick={() => onOpenSession(relatedSessionId)}>
            {incoming ? "View source" : "Open thread"}
            <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
