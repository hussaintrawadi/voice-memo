import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LogOut, MonitorSmartphone, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button, Card, ErrorNote, Meter, SectionTitle, Spinner } from "../components/ui";
import { api, type Connection, json, type ProviderInfo, type SessionInfo, type StatusData } from "../lib/api";
import { API_BASE } from "../lib/platform";
import { formatBytes, formatTime } from "../lib/format";
import { logout as signOut } from "../lib/session";

const LANGUAGES = [
  { value: "auto", label: "Detect automatically" },
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
];

function usage(p: ProviderInfo): string {
  const u = p.usedToday;
  const q = p.quota;
  if (q.audioSecondsPerDay) return `${Math.round(u.audio_seconds / 60)} / ${Math.round(q.audioSecondsPerDay / 60)} min today`;
  if (q.tokensPerDay) return `${(u.tokens / 1000).toFixed(1)}K / ${q.tokensPerDay / 1000}K tokens today`;
  if (q.costUnitsPerDay) return `${u.cost_units} / ${q.costUnitsPerDay} neurons today`;
  if (q.costUnitsLifetime) return `$${(u.cost_units / 1_000_000).toFixed(2)} of $${q.costUnitsLifetime / 1_000_000} credit used`;
  if (q.requestsPerDay) return `${u.requests} / ${q.requestsPerDay} requests today`;
  return `${u.requests} requests today`;
}

function VocabularyCard() {
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const vocab = useQuery({
    queryKey: ["vocabulary"],
    queryFn: () => api<{ terms: { id: string; term: string; source: string; count: number }[] }>("/vocabulary"),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["vocabulary"] });
  const add = useMutation({
    mutationFn: (value: string) => api("/vocabulary", { method: "POST", body: json({ term: value }) }),
    onSuccess: () => {
      setTerm("");
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/vocabulary/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const mine = vocab.data?.terms.filter((t) => t.source === "user") ?? [];
  const learned = vocab.data?.terms.filter((t) => t.source === "learned") ?? [];

  const chip = (t: { id: string; term: string }, tone: string) => (
    <span key={t.id} className={`inline-flex items-center gap-1 rounded-full py-1 pl-3 pr-1.5 text-sm ${tone}`}>
      {t.term}
      <button type="button" aria-label={`Remove ${t.term}`} onClick={() => remove.mutate(t.id)} className="rounded-full p-0.5">
        <X className="size-3.5" />
      </button>
    </span>
  );

  return (
    <Card className="p-4">
      <p className="text-sm text-muted">
        Names and words Voice Memo should always spell right, like your projects, clients and tools.
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (term.trim().length > 1) add.mutate(term.trim());
        }}
      >
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="e.g. Lumina"
          aria-label="New word"
          className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 outline-none focus:border-brand"
        />
        <Button type="submit" size="sm" busy={add.isPending} className="!h-10">
          <Plus className="size-3.5" /> Add
        </Button>
      </form>
      {mine.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{mine.map((t) => chip(t, "bg-brand-soft text-brand"))}</div>}
      {learned.length > 0 && (
        <>
          <p className="mt-4 text-xs text-muted">
            Learned from your memos. Remove any that are misspelled and they won't be used again.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">{learned.map((t) => chip(t, "bg-surface-2 text-muted"))}</div>
        </>
      )}
      <ErrorNote error={add.error ?? remove.error} />
    </Card>
  );
}

function describeDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  if (/Android app/.test(ua)) return "Android app";
  if (/Mac app/.test(ua)) return "Mac app";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function AccountCard({ email }: { email: string | null | undefined }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<{ sessions: SessionInfo[] }>("/auth/sessions"),
  });
  const change = useMutation({
    mutationFn: () => api("/auth/password", { method: "POST", body: json({ currentPassword: current, newPassword: next }) }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setOpen(false);
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3">
        <p className="text-xs text-muted">Signed in as</p>
        <p className="text-[15px] font-medium">{email ?? "…"}</p>
        {done && <p className="mt-1 text-xs text-ok">Password changed. Other devices were signed out.</p>}
        {open ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              change.mutate();
            }}
          >
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="Current password"
              autoComplete="current-password"
              required
              className="h-10 w-full rounded-xl border border-line bg-bg px-3 outline-none focus:border-brand"
            />
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="New password (10+ characters)"
              autoComplete="new-password"
              minLength={10}
              required
              className="h-10 w-full rounded-xl border border-line bg-bg px-3 outline-none focus:border-brand"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="primary" busy={change.isPending}>
                Save password
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
            <ErrorNote error={change.error} />
          </form>
        ) : (
          <Button className="mt-3" size="sm" onClick={() => setOpen(true)}>
            Change password
          </Button>
        )}
      </div>
      <p className="border-y border-line px-4 py-2 text-xs font-medium text-muted">Signed-in devices</p>
      <ul className="divide-y divide-line">
        {sessions.data?.sessions.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <MonitorSmartphone className="size-4 shrink-0 text-muted" />
              <div className="min-w-0">
                <p className="truncate text-[15px]">
                  {describeDevice(d.device)}
                  {d.current && <span className="ml-1.5 text-xs text-ok">this device</span>}
                </p>
                <p className="text-xs text-muted">
                  Active {new Date(d.lastSeenAt ?? d.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
            {!d.current && (
              <button type="button" className="text-xs text-danger" onClick={() => revoke.mutate(d.id)}>
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ProviderRow({ p }: { p: ProviderInfo }) {
  const state = !p.configured
    ? { label: "No API key", tone: "text-muted" }
    : !p.enabled
      ? { label: "Turned off", tone: "text-muted" }
      : p.coolingDownUntil
        ? { label: `Resting until ${formatTime(p.coolingDownUntil)}`, tone: "text-warn" }
        : { label: "Ready", tone: "text-ok" };
  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-medium">{p.provider}</span>
        <span className={`text-xs ${state.tone}`}>{state.label}</span>
      </div>
      <p className="truncate text-xs text-muted">{p.model}</p>
      {p.configured && <p className="mt-0.5 text-xs text-muted">{usage(p)}</p>}
      {p.lastError && p.coolingDownUntil && <p className="mt-0.5 truncate text-xs text-warn">{p.lastError}</p>}
    </li>
  );
}

/** Connection details for Claude (the MCP connector) and the apps already connected. */
function ClaudeCard() {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api<{ connections: Connection[] }>("/connections") });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });
  const [copied, setCopied] = useState(false);
  const url = `${API_BASE || window.location.origin}/mcp`;
  return (
    <Card className="p-4">
      <p className="text-sm text-muted">
        Let Claude read your memos, projects and action points, and add notes, action points and reminders for you. In
        Claude, open Settings, then Connectors, add a custom connector with this URL, and sign in when asked.
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 p-2">
        <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          }}
        >
          <Copy className="size-3.5" /> {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {connections.data && connections.data.connections.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {connections.data.connections.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                {c.name}
                <span className="text-xs text-muted"> · connected {new Date(c.createdAt).toLocaleDateString()}</span>
              </span>
              <button type="button" className="text-xs text-danger" onClick={() => revoke.mutate(c.id)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={connections.error ?? revoke.error} />
    </Card>
  );
}

export function Settings() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api<StatusData>("/status") });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ name: string; email: string | null; settings: { transcriptionLanguage: string } }>("/settings"),
  });
  const tokens = useQuery({
    queryKey: ["capture-tokens"],
    queryFn: () => api<{ tokens: { id: string; label: string; created_at: number; last_used_at: number | null }[] }>("/capture-tokens"),
  });

  const saveSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) => api("/settings", { method: "PATCH", body: json(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });
  const [newToken, setNewToken] = useState<string | null>(null);
  const createToken = useMutation({
    mutationFn: () => api<{ token: string }>("/capture-tokens", { method: "POST", body: json({ label: "Automation" }) }),
    onSuccess: (d) => {
      setNewToken(d.token);
      void queryClient.invalidateQueries({ queryKey: ["capture-tokens"] });
    },
  });
  const revokeToken = useMutation({
    mutationFn: (id: string) => api(`/capture-tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["capture-tokens"] }),
  });
  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: () => queryClient.clear(),
  });

  const speech = status.data?.providers.filter((p) => p.kind === "speech") ?? [];
  const llm = status.data?.providers.filter((p) => p.kind === "llm") ?? [];

  return (
    <div className="pb-8">
      <h1 className="pt-2 font-serif text-3xl">Settings</h1>

      <SectionTitle>Transcription</SectionTitle>
      <Card className="p-4">
        <label className="block text-sm font-medium" htmlFor="language">
          Language
        </label>
        <select
          id="language"
          value={settings.data?.settings.transcriptionLanguage ?? "auto"}
          onChange={(e) => saveSettings.mutate({ transcriptionLanguage: e.target.value })}
          className="mt-1 h-11 w-full rounded-xl border border-line bg-bg px-3"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-muted">
          Leave on automatic for Hinglish. Pick English if Hindi words keep coming out in Devanagari.
        </p>
      </Card>

      <SectionTitle>Names &amp; words</SectionTitle>
      <VocabularyCard />

      <SectionTitle>Storage</SectionTitle>
      <Card className="space-y-4 p-4">
        {status.isPending && <Spinner />}
        {status.data && (
          <>
            <Meter
              label={`Audio · ${formatBytes(status.data.storage.audioBytes)} of ${formatBytes(status.data.storage.audioCapBytes)}`}
              value={status.data.storage.audioBytes}
              max={status.data.storage.audioCapBytes}
            />
            <Meter
              label={`Search index · ${status.data.vectors.stored ?? "?"} of ${status.data.vectors.capacity} thoughts`}
              value={status.data.vectors.stored ?? 0}
              max={status.data.vectors.capacity}
            />
            <p className="text-xs text-muted">
              Audio is deleted {status.data.retentionDays} days after recording unless you pin it. Transcripts and
              everything extracted stay forever.
            </p>
          </>
        )}
      </Card>

      <SectionTitle>Free AI providers</SectionTitle>
      <Card className="overflow-hidden">
        <p className="border-b border-line px-4 py-2 text-xs font-medium text-muted">Speech to text, in order of use</p>
        <ul className="divide-y divide-line">
          {speech.map((p) => (
            <ProviderRow key={`${p.provider}:${p.model}`} p={p} />
          ))}
        </ul>
        <p className="border-y border-line px-4 py-2 text-xs font-medium text-muted">Understanding, in order of use</p>
        <ul className="divide-y divide-line">
          {llm.map((p) => (
            <ProviderRow key={`${p.provider}:${p.model}`} p={p} />
          ))}
        </ul>
      </Card>

      <SectionTitle>Claude</SectionTitle>
      <ClaudeCard />

      <SectionTitle>Account</SectionTitle>
      <AccountCard email={settings.data?.email} />

      <SectionTitle>Device upload tokens</SectionTitle>
      <Card className="p-4">
        <p className="text-sm text-muted">
          Your Android and Mac apps create one automatically so recordings upload in the background. Revoke a token if
          you lose a device. You can also create one for automations such as an iOS Shortcut.
        </p>
        {newToken && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 p-2">
            <code className="min-w-0 flex-1 truncate text-xs">{newToken}</code>
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(newToken)}>
              <Copy className="size-3.5" /> Copy
            </Button>
          </div>
        )}
        {newToken && (
          <p className="mt-2 text-xs text-muted">
            Shown once. Send audio with POST {window.location.origin}/api/capture and the header Authorization: Bearer
            &lt;token&gt;.
          </p>
        )}
        <ul className="mt-3 divide-y divide-line">
          {tokens.data?.tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                {t.label}
                <span className="text-xs text-muted">
                  {" "}
                  · {t.last_used_at ? `used ${new Date(t.last_used_at).toLocaleDateString()}` : "never used"}
                </span>
              </span>
              <button type="button" className="text-xs text-danger" onClick={() => revokeToken.mutate(t.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
        <Button className="mt-3" size="sm" busy={createToken.isPending} onClick={() => createToken.mutate()}>
          <Plus className="size-3.5" /> New capture token
        </Button>
      </Card>

      <div className="mt-8 flex justify-center">
        <Button variant="ghost" busy={logout.isPending} onClick={() => logout.mutate()}>
          <LogOut className="size-4" /> Sign out
        </Button>
      </div>
      <ErrorNote error={saveSettings.error ?? createToken.error} />
    </div>
  );
}
