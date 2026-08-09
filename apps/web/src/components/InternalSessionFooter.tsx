import { ArrowLeft01Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";

export function InternalSessionFooter({ onReturn }: { onReturn?: () => void }) {
  return (
    <div className="internal-session-footer" role="note">
      <span><HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden="true" />Subagent child session · prompts are managed by Forge</span>
      {onReturn && (
        <Button type="button" variant="outline" size="sm" onClick={onReturn}>
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          Return to parent
        </Button>
      )}
    </div>
  );
}
