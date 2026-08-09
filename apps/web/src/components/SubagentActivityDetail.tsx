import { ArrowLeft01Icon, Cancel01Icon, Copy01Icon, Loading03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { canCancelSubagentStatus, isActiveSubagentStatus, type SubagentActivityItem } from "../lib/subagentActivity";
import {
  formatSubagentAge,
  formatSubagentDuration,
  formatSubagentTimestamp,
  subagentNotificationCopy,
  subagentRoleLabel,
  subagentStatusLabel,
} from "../lib/subagentPresentation";
import { MarkdownText } from "./MarkdownText";
import { SubagentStatusIcon } from "./SubagentStatusIcon";

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
    <>
      <header className={`subagent-popover-header subagent-detail-header${embedded ? " subagent-detail-header--embedded" : ""}`}>
        <Button ref={backButtonRef} type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to Agents">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <div>
          <h2 className="subagent-popover-title">{subagentRoleLabel(item.role)}</h2>
          {duration && <span className="subagent-detail-duration">{duration}</span>}
        </div>
        {!embedded && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Agents">
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        )}
      </header>
      <ScrollArea className="subagent-popover-scroll subagent-detail-scroll">
        <div className="subagent-detail-body">
          <div className="subagent-detail-summary">
            <SubagentStatusIcon item={item} />
            <div>
              <strong>{subagentStatusLabel(item.status)}</strong>
              <span>{duration ? `${duration} elapsed` : formatSubagentAge(item.updatedAt, now)}</span>
            </div>
          </div>

          <section className="subagent-detail-section">
            <h3>Task</h3>
            <MarkdownText className="subagent-detail-markdown markdown-body">{item.task}</MarkdownText>
          </section>

          <section className="subagent-detail-section">
            <header>
              <h3>{item.error ? "Error" : "Result"}</h3>
              {response && (
                <Button type="button" variant="ghost" size="icon-xs" className="subagent-copy-button" onClick={onCopy} aria-label={copied ? "Preview copied" : "Copy result or error preview"} title={copied ? "Copied" : "Copy preview"}>
                  <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
                </Button>
              )}
            </header>
            {response
              ? <MarkdownText className={`subagent-detail-markdown markdown-body${item.error ? " subagent-detail-error" : ""}`}>{response}</MarkdownText>
              : <p className="subagent-detail-placeholder">{waiting ? "No result yet." : "No result preview was retained."}</p>}
          </section>

          <section className="subagent-detail-section">
            <h3>Run details</h3>
            <dl className="subagent-detail-metadata">
              <div><dt>Child session</dt><dd><code>{item.childSessionId ?? "Legacy tool — not linked"}</code></dd></div>
              <div><dt>Created</dt><dd>{formatSubagentTimestamp(item.createdAt)}</dd></div>
              <div><dt>Started</dt><dd>{formatSubagentTimestamp(item.startedAt)}</dd></div>
              <div><dt>Ended</dt><dd>{formatSubagentTimestamp(item.endedAt)}</dd></div>
              <div><dt>Notification</dt><dd className={item.notification?.status === "uncertain" ? "subagent-notification--uncertain" : undefined}>{subagentNotificationCopy(item)}</dd></div>
            </dl>
            {item.notification?.error && <p className="subagent-notification-error">{item.notification.error}</p>}
          </section>

          {(actionError || item.source === "durable") && (
            <section className="subagent-detail-actions">
              {actionError && <p className="subagent-cancel-error" role="alert">{actionError}</p>}
              <div>
                {canCancelSubagentStatus(item.status) && (
                  <Button type="button" variant="destructive" size="sm" onClick={onCancel} disabled={cancelling}>
                    {cancelling ? <HugeiconsIcon icon={Loading03Icon} className="subagent-activity-icon-spin" /> : <HugeiconsIcon icon={Cancel01Icon} />}
                    {cancelling ? "Cancelling…" : "Cancel run"}
                  </Button>
                )}
              </div>
            </section>
          )}
        </div>
      </ScrollArea>
    </>
  );
}
