import { apiUrl, CLIENT_LABEL, sessionStore } from "./platform";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Adds the app's bearer token and client label; browsers rely on the session cookie. */
export function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  const token = sessionStore.get();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (CLIENT_LABEL) headers.set("x-client", CLIENT_LABEL);
  return headers;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api${path}`), { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, navigator.onLine ? "Can't reach Voice Memo right now" : "You're offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page (e.g. a proxy); fall through to the status message.
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("vm:unauthorized"));
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const json = (body: unknown) => JSON.stringify(body);

export type RecordingStatus = "queued" | "transcribing" | "analyzing" | "organizing" | "completed" | "retrying" | "failed";

export const IN_PROGRESS: RecordingStatus[] = ["queued", "transcribing", "analyzing", "organizing", "retrying"];

export interface RecordingSummary {
  id: string;
  title: string | null;
  summary: string | null;
  category: string | null;
  status: RecordingStatus;
  statusDetail: string | null;
  lastError: string | null;
  recordedAt: number;
  durationSec: number | null;
  source: string;
  hasAudio: boolean;
  keepAudio: boolean;
  projects: string[];
  thoughtCount: number;
  openTasks: number;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptVersion {
  version: number;
  text: string;
  segments: Segment[] | null;
  language: string | null;
  provider: string | null;
  model: string | null;
  createdAt: number;
}

export interface Thought {
  id: string;
  idx: number;
  type: string;
  title: string;
  summary: string;
  content: string;
  project: string | null;
  project_id: string | null;
  topics: string[];
  entities: { kind: string; name: string }[];
}

export type TaskStatus = "suggested" | "accepted" | "dismissed" | "done";

export interface Task {
  id: string;
  thought_id?: string | null;
  recording_id?: string;
  title: string;
  due_date: string | null;
  due_text?: string | null;
  status: TaskStatus;
  project?: string | null;
  project_id?: string | null;
}

export interface Decision {
  id: string;
  statement: string;
  rationale?: string | null;
  status: string;
  decided_at: number;
  recording_id?: string;
}

export interface Question {
  id: string;
  question: string;
  status: string;
  resolution?: string | null;
  recording_id?: string;
  created_at?: number;
}

export interface RecordingDetail {
  recording: RecordingSummary & {
    summaryDetailed: string | null;
    language: string | null;
    titleEdited: boolean;
    audioDeletedAt: number | null;
    /** Signed, short-lived path to the audio (works without cookies). */
    audioUrl: string | null;
    attempts: number;
  };
  transcripts: {
    raw: TranscriptVersion | null;
    cleaned: TranscriptVersion | null;
    edited: TranscriptVersion | null;
  };
  thoughts: Thought[];
  tasks: Task[];
  decisions: Decision[];
  questions: Question[];
  analysis: { version: number; provider: string; model: string; prompt_version: string; created_at: number } | null;
  /** What this memo changed in items that were already open. */
  changes?: ContextChange[];
}

export interface HomeData {
  today: string;
  last24h: { recordings: number; seconds: number; processing: number | null; failed: number | null };
  tasks: Task[];
  questions: Question[];
  decisions: Decision[];
}

export interface SearchResult {
  id: string;
  title: string;
  summary: string;
  type: string;
  recorded_at: number;
  recording_id: string;
  recording_title: string | null;
  project: string | null;
  score: number;
}

export interface ProviderInfo {
  kind: "speech" | "llm";
  provider: string;
  model: string;
  configured: boolean;
  enabled: boolean;
  coolingDownUntil: number | null;
  lastError: string | null;
  usedToday: { requests: number; tokens: number; audio_seconds: number; cost_units: number };
  quota: {
    requestsPerDay?: number;
    tokensPerDay?: number;
    audioSecondsPerDay?: number;
    costUnitsPerDay?: number;
    costUnitsLifetime?: number;
  };
}

export interface StatusData {
  providers: ProviderInfo[];
  storage: { audioBytes: number; audioCapBytes: number };
  vectors: { stored: number | null; capacity: number; budgetReached: boolean };
  retentionDays: number;
  setupCodeConfigured: boolean;
}

export interface AuthState {
  initialized: boolean;
  user: { id: string; name: string; email: string | null } | null;
}

export interface SessionInfo {
  id: string;
  device: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  current: boolean;
}

export interface ProjectBrief {
  current_focus: string;
  overview: string;
  recent_ideas: string[];
  decisions: string[];
  open_questions: string[];
  next_steps: string[];
  evolution: string;
}

export interface ProjectSummaryItem {
  id: string;
  name: string;
  aliases: string[];
  description: string | null;
  summary: ProjectBrief | null;
  summaryUpdatedAt: number | null;
  status: string;
  suggested: boolean;
  createdAt: number;
  thoughtCount: number;
  memoCount: number;
  lastActivity: number | null;
  openTasks: number;
  openQuestions: number;
}

export interface ProjectDetail {
  project: Omit<ProjectSummaryItem, "thoughtCount" | "memoCount" | "lastActivity" | "openTasks" | "openQuestions">;
  counts: { thoughts: number; memos: number; first: number | null; last: number | null } | null;
  thoughts: {
    id: string;
    type: string;
    title: string;
    summary: string;
    recorded_at: number;
    recording_id: string;
    recording_title: string | null;
  }[];
  tasks: Task[];
  decisions: Decision[];
  questions: Question[];
  topics: { name: string; count: number }[];
  people: { name: string; kind: string; count: number }[];
}

export interface RangeSummary {
  headline: string;
  overview: string;
  projects: { name: string; summary: string; highlights: string[] }[];
  key_ideas: string[];
  decisions: string[];
  action_items: string[];
  open_questions: string[];
  themes: string[];
  emerging: string | null;
  reflection: string;
}

export interface RangeStats {
  memos: number;
  minutes: number;
  thoughts: number;
  tasksCreated: number;
  tasksDone: number;
  decisions: number;
  openQuestions: number;
  activeDays: number;
  projects: { name: string; thoughts: number }[];
  topics: { name: string; count: number }[];
}

export interface RangeSummaryResult {
  id: string | null;
  start: string;
  end: string;
  summary: RangeSummary | null;
  stats: RangeStats;
  createdAt: number | null;
  cached: boolean;
  provider: string | null;
  model: string | null;
}

export interface Reminder {
  id: string;
  text: string;
  remind_at: number;
  status: "suggested" | "pending" | "sent" | "done" | "cancelled";
  origin: "voice" | "claude" | "app";
  recording_id: string | null;
  task_id: string | null;
  created_at: number;
}

export interface Connection {
  id: string;
  name: string;
  createdAt: number;
}

/** Something a memo changed in an item that was already open (see worker/pipeline/reconcile.ts). */
export interface ContextChange {
  id: string;
  item_type: "task" | "decision" | "reminder" | "question";
  item_id: string;
  action: string;
  summary: string;
  evidence: string | null;
  created_at: number;
  recording_id?: string | null;
  recording_title?: string | null;
}
