export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return "–";
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatDay(ts: number): string {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86_400_000);
  const key = dayKey(ts);
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/** formatDay for use mid-sentence: "today", "yesterday", or the full date with its capitals. */
export function formatDayInline(ts: number): string {
  const day = formatDay(ts);
  return day === "Today" || day === "Yesterday" ? day.toLowerCase() : day;
}

/** "2026-09-18" → "Tomorrow" / "Fri 18 Sep" */
export function formatDueDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const key = dayKey(due.getTime());
  if (key === dayKey(Date.now())) return "Today";
  if (key === dayKey(Date.now() + 86_400_000)) return "Tomorrow";
  if (key === dayKey(Date.now() - 86_400_000)) return "Yesterday";
  return due.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function isOverdue(date: string | null): boolean {
  return Boolean(date && date < dayKey(Date.now()));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
