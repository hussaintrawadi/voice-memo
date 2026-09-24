import { AlertTriangle, CheckCircle2, Loader2, Pencil, RotateCw } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "wouter";
import type { RecordingStatus } from "../lib/api";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-brand text-bg hover:opacity-90",
  secondary: "bg-surface-2 text-ink hover:bg-line",
  ghost: "text-muted hover:text-ink hover:bg-surface-2",
  danger: "bg-danger/10 text-danger hover:bg-danger/20",
};

export function Button({
  variant = "secondary",
  size = "md",
  busy = false,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; busy?: boolean }) {
  const sizing = size === "sm" ? "h-8 px-3 text-sm gap-1.5" : "h-11 px-4 text-[15px] gap-2";
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center rounded-full font-medium transition disabled:opacity-50 ${sizing} ${variants[variant]} ${className}`}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "brand" | "accent" }) {
  const tones = {
    neutral: "bg-surface-2 text-muted",
    brand: "bg-brand-soft text-brand",
    accent: "bg-accent-soft text-accent",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-surface ${className}`}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-7 flex items-center justify-between px-1">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{children}</h2>
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-muted" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {body && <p className="mt-1 text-sm text-muted">{body}</p>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

const STATUS_LABEL: Record<RecordingStatus, string> = {
  queued: "Queued",
  transcribing: "Transcribing",
  analyzing: "Analyzing",
  organizing: "Organizing",
  completed: "Done",
  retrying: "Retrying",
  failed: "Needs attention",
};

export function StatusBadge({ status, detail }: { status: RecordingStatus; detail?: string | null }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-ok">
        <CheckCircle2 className="size-3.5" aria-hidden /> {STATUS_LABEL[status]}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
        <AlertTriangle className="size-3.5" aria-hidden /> {STATUS_LABEL[status]}
      </span>
    );
  }
  const Icon = status === "retrying" ? RotateCw : Loader2;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-warn" title={detail ?? undefined}>
      <Icon className="size-3.5 animate-spin" aria-hidden />
      {status === "retrying" ? "Waiting for a free AI slot" : (detail ?? STATUS_LABEL[status])}
    </span>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{pct.toFixed(pct < 1 ? 1 : 0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full ${pct > 85 ? "bg-danger" : pct > 60 ? "bg-warn" : "bg-brand"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Page title row with optional actions on the right. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-3 pt-2">
      <div className="min-w-0">
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        <h1 className="font-serif text-3xl leading-tight">{title}</h1>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1 pt-1">{actions}</div>}
    </header>
  );
}

export function IconLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="grid size-10 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
    >
      {children}
    </Link>
  );
}

/**
 * Pencil that appears when the pointer is over a row. Phones have no hover, so it stays
 * hidden there and a long press opens the same editor (see `useEditGestures`).
 * The row it sits in needs the `group` class.
 */
export function EditButton({ onClick, label = "Edit" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="hidden size-8 shrink-0 place-items-center rounded-full text-muted opacity-0 transition hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:grid"
    >
      <Pencil className="size-4" />
    </button>
  );
}

/** Bulleted list used by summaries and project briefs. */
export function Bullets({ items, tone = "neutral" }: { items: string[]; tone?: "neutral" | "accent" | "brand" }) {
  if (!items.length) return null;
  const dot = { neutral: "bg-muted", accent: "bg-accent", brand: "bg-brand" }[tone];
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-[15px] leading-snug">
          <span className={`mt-[0.55rem] size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
