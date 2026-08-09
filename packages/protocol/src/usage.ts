export interface UsageTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface UsageCostTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageModelSummary {
  provider: string;
  model: string;
  responses: number;
  tokens: number;
  cost: number;
}

export interface UsageDaySummary {
  day: string;
  tokens: number;
  cost: number;
}

export interface UsageSummary {
  days: number;
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  responses: number;
  transcripts: number;
  duplicates: number;
  tokens: UsageTokenTotals;
  cost: UsageCostTotals;
  models: UsageModelSummary[];
  daily: UsageDaySummary[];
}
