import { useInfiniteQuery } from "@tanstack/react-query";
import { RecordingCard } from "../components/RecordingCard";
import { Button, EmptyState, ErrorNote, Spinner } from "../components/ui";
import { api, IN_PROGRESS, type RecordingSummary } from "../lib/api";
import { dayKey, formatDay, formatDuration } from "../lib/format";

interface Page {
  recordings: RecordingSummary[];
  nextBefore: number | null;
}

export function Timeline() {
  const query = useInfiniteQuery({
    queryKey: ["recordings", "timeline"],
    queryFn: ({ pageParam }) => api<Page>(`/recordings?limit=30${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.recordings.some((r) => IN_PROGRESS.includes(r.status))) ? 5000 : false,
  });

  const recordings = query.data?.pages.flatMap((p) => p.recordings) ?? [];
  const days = new Map<string, RecordingSummary[]>();
  for (const r of recordings) {
    const key = dayKey(r.recordedAt);
    days.set(key, [...(days.get(key) ?? []), r]);
  }

  return (
    <div>
      <h1 className="pt-2 font-serif text-3xl">Timeline</h1>
      {query.isPending && <Spinner />}
      <ErrorNote error={query.error} />
      {query.isSuccess && recordings.length === 0 && (
        <EmptyState title="No memos yet" body="Everything you record shows up here, newest first." />
      )}

      {[...days.entries()].map(([key, items]) => {
        const total = items.reduce((s, r) => s + (r.durationSec ?? 0), 0);
        return (
          <section key={key} className="mt-6">
            <div className="sticky top-0 z-10 -mx-4 flex items-baseline justify-between bg-bg/90 px-5 py-2 backdrop-blur">
              <h2 className="font-medium">{formatDay(items[0].recordedAt)}</h2>
              <span className="text-xs text-muted">
                {items.length} {items.length === 1 ? "memo" : "memos"} · {formatDuration(total)}
              </span>
            </div>
            <div className="space-y-2.5">
              {items.map((r) => (
                <RecordingCard key={r.id} recording={r} />
              ))}
            </div>
          </section>
        );
      })}

      {query.hasNextPage && (
        <div className="mt-6 flex justify-center">
          <Button onClick={() => void query.fetchNextPage()} busy={query.isFetchingNextPage}>
            Load older memos
          </Button>
        </div>
      )}
    </div>
  );
}
