/**
 * Turns free text into a safe FTS5 prefix query: "word"* OR "word"* ...
 * Combining marks (\p{M}) count as word characters so Devanagari words stay whole.
 */
export function ftsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words)].filter((w) => w.length > 1).slice(0, 12);
  return unique.length ? unique.map((w) => `"${w}"*`).join(" OR ") : null;
}

/** Reciprocal-rank fusion of several ranked id lists. */
export function fuseRankings(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
