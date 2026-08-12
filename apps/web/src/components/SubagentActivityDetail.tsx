import {
  ArrowLeft01Icon,
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { RefObject } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { canCancelSubagentStatus, isActiveSubagentStatus, type SubagentActivityItem } from "../lib/subagentActivity";
import {
  cleanSubagentResult,
  formatSubagentDuration,
  formatSubagentTimestamp,
  subagentNotificationCopy,
  subagentRoleLabel,
} from "../lib/subagentPresentation";
import { MarkdownText } from "./MarkdownText";
import { SubagentStatusBadge, SubagentStatusIcon } from "./SubagentStatusIcon";

export function SubagentActivityDetail({ item, now, copied, cancelling, actionError, backButtonRef, onBack, onClose, onCopy, onCancel, embedded = false }: {
  item: SubagentActivityItem;
  now: number;
  copied: boolean;
  cancelling: boolean;
  actionError?: string;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  onClose: () => void;
  onCopy: () => void;
  onCancel: () => void;
  embedded?: boolean;
}) {
  const duration = formatSubagentDuration(item, now);
  const response = item.error ?? item.result;
  const waiting = isActiveSubagentStatus(item.status) || item.status === "needs_attention";

  return (
    <div className="subagent-detail-view">
      <header className={`subagent-detail-header${embedded ? " subagent-detail-header--embedded" : ""}`}>
        <Button ref={backButtonRef} type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to Agents">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <SubagentStatusIcon item={item} />
        <strong className="subagent-detail-role">{subagentRoleLabel(item.role)}</strong>
        <SubagentStatusBadge item={item} />
        <span className="subagent-detail-timer">
          <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} />
          {duration ?? "—"}
        </span>
        {!embedded && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Agents">
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        )}
      </header>
      <ScrollArea className="subagent-detail-scroll">
        <div className="subagent-detail-body">
          <section className="subagent-detail-task">
            <strong>Task</strong>
            <MarkdownText className="subagent-detail-markdown markdown-body">{item.task}</MarkdownText>
          </section>

          {item.notification?.status === "uncertain" && (
            <Alert className="subagent-inline-alert subagent-inline-alert--warning">
              <SubagentStatusIcon item={{ ...item, status: "needs_attention" }} />
              <AlertDescription>
                Delivery to the parent thread is uncertain. Check the parent conversation before retrying this task.
              </AlertDescription>
            </Alert>
          )}

          <section className="subagent-detail-result">
            <div className="subagent-detail-section-heading">
              <h3 className="subagent-result-label">{item.error ? "Outcome" : "Result"}</h3>
              {response && (
                <Button type="button" variant="ghost" size="sm" onClick={onCopy} aria-label={copied ? "Preview copied" : "Copy result or error preview"}>
                  <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
            </div>
            <div className={`subagent-result-card${item.error ? " subagent-result-card--error" : ""}`}>
              {response
                ? <MarkdownText className={`subagent-detail-markdown markdown-body${item.error ? " subagent-detail-error" : ""}`}>{cleanSubagentResult(response)}</MarkdownText>
                : <p className="subagent-detail-placeholder">{waiting ? "No result yet." : "No result preview was retained."}</p>}
            </div>
          </section>

          <details className="subagent-run-details">
            <summary>Run details</summary>
            <dl>
              <div><dt>Child session</dt><dd><code>{item.childSessionId ?? "Legacy tool — not linked"}</code></dd></div>
              <div><dt>Role</dt><dd>{subagentRoleLabel(item.role)}</dd></div>
              <div><dt>Created</dt><dd>{formatSubagentTimestamp(item.createdAt)}</dd></div>
              <div><dt>Started</dt><dd>{formatSubagentTimestamp(item.startedAt)}</dd></div>
              <div><dt>Ended</dt><dd>{formatSubagentTimestamp(item.endedAt)}</dd></div>
              <div><dt>Notification</dt><dd className={item.notification?.status === "uncertain" ? "subagent-notification--uncertain" : undefined}>{subagentNotificationCopy(item)}</dd></div>
            </dl>
            {item.notification?.error && <p className="subagent-notification-error">{item.notification.error}</p>}
          </details>
        </div>
      </ScrollArea>

      {(actionError || canCancelSubagentStatus(item.status)) && (
        <footer className="subagent-detail-actions">
          {actionError && (
            <Alert variant="destructive" className="subagent-action-error">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {canCancelSubagentStatus(item.status) && (
            <Button type="button" variant="destructive" size="sm" onClick={onCancel} disabled={cancelling}>
              {cancelling ? <HugeiconsIcon icon={Loading03Icon} className="subagent-activity-icon-spin" /> : <HugeiconsIcon icon={Cancel01Icon} />}
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}
