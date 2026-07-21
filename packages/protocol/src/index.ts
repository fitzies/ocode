export type ConnectionState = "connected" | "reconnecting" | "offline";
export type SessionStatus = "idle" | "running" | "waiting" | "failed";

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  status: SessionStatus;
  model: string;
}

interface TimelineEntryBase {
  id: string;
  createdAt: string;
}

export interface MessageEntry extends TimelineEntryBase {
  kind: "message";
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

export interface ThinkingEntry extends TimelineEntryBase {
  kind: "thinking";
  content: string;
  active?: boolean;
}

export interface ToolEntry extends TimelineEntryBase {
  kind: "tool";
  name: string;
  summary: string;
  detail?: string;
  status: "running" | "completed" | "failed";
}

export type TimelineEntry = MessageEntry | ThinkingEntry | ToolEntry;

