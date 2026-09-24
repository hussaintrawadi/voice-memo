import { useQuery } from "@tanstack/react-query";
import { Search as SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, Chip, EmptyState, ErrorNote, Spinner } from "../components/ui";
import { api, type SearchResult } from "../lib/api";
import { capitalize, formatDay } from "../lib/format";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function Search() {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 350);
  const query = useQuery({
    queryKey: ["search", term],
    queryFn: () => api<{ results: SearchResult[]; semantic: boolean }>(`/search?q=${encodeURIComponent(term)}`),
    enabled: term.length > 1,
    staleTime: 30_000,
  });

  return (
    <div>
      <h1 className="pt-2 font-serif text-3xl">Search</h1>
      <div className="relative mt-4">
        <SearchIcon className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Lumina pricing, that idea about menu photos"
          aria-label="Search your memos"
          className="h-12 w-full rounded-2xl border border-line bg-surface pl-10 pr-4 text-[15px] outline-none focus:border-brand"
        />
      </div>
      <p className="mt-2 px-1 text-xs text-muted">Search matches meaning, not just exact words.</p>

      {query.isFetching && <Spinner />}
      <ErrorNote error={query.error} />
      {query.data && !query.data.semantic && (
        <p className="mt-3 text-xs text-warn">Meaning-based search is unavailable right now, so these are keyword matches only.</p>
      )}
      {query.data && query.data.results.length === 0 && !query.isFetching && (
        <EmptyState title="Nothing found" body="Try different words, or a broader phrase." />
      )}

      <div className="mt-4 space-y-2.5">
        {query.data?.results.map((r) => (
          <Link key={r.id} href={`/r/${r.recording_id}`}>
            <Card className="p-4 transition hover:border-muted/40">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span>{formatDay(r.recorded_at)}</span>
                <Chip tone="accent">{capitalize(r.type)}</Chip>
                {r.project && <Chip tone="brand">{r.project}</Chip>}
              </div>
              <h3 className="mt-1.5 font-medium">{r.title}</h3>
              <p className="mt-1 line-clamp-2 text-sm text-muted">{r.summary}</p>
              {r.recording_title && r.recording_title !== r.title && (
                <p className="mt-2 text-xs text-muted">In “{r.recording_title}”</p>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
