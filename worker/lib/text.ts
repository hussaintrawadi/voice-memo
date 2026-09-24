import type { Segment } from "../ai/types";

/** Splits text on segment or sentence boundaries into pieces of at most `max` characters. */
export function chunkText(text: string, segments: Segment[] | null, max: number): string[] {
  const units = segments?.length ? segments.map((s) => s.text) : text.split(/(?<=[.!?।])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current && current.length + unit.length + 1 > max) {
      chunks.push(current);
      current = "";
    }
    // A single unit longer than max is hard-split.
    for (let i = 0; i < unit.length; i += max) {
      const piece = unit.slice(i, i + max);
      current = current ? `${current} ${piece}` : piece;
      if (current.length >= max) {
        chunks.push(current);
        current = "";
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Vocabulary is for names and jargon: short, and capitalised or containing a digit.
 * Scripts without letter case (e.g. Devanagari) are allowed through.
 */
export function isNameLike(term: string): boolean {
  const t = term.trim();
  if (t.length < 2 || t.length > 40 || t.split(/\s+/).length > 3) return false;
  const hasLatin = /[a-z]/i.test(t);
  return /[\p{Lu}\d]/u.test(t) || (!hasLatin && /\p{L}/u.test(t));
}

export interface ScoredSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

/** Phrases Whisper is known to invent over silence or noise. */
const HALLUCINATIONS = new Set([
  "thank you",
  "thanks",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "thank you for watching the video",
  "thank you so much for watching",
  "please like and subscribe",
  "you",
  "bye",
  "okay",
  "subscribe",
  "please subscribe",
  "subtitles by the amaraorg community",
  // Seen from whisper-large-v3 on silent recordings.
  "diolch yn fawr iawn am wylior fideo",
  "diolch yn fawr",
  "shukriya",
  "धन्यवाद",
]);

const normalizePhrase = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/**
 * Drops segments Whisper most likely invented: high "no speech" probability with low confidence,
 * or a stock phrase in a segment that isn't clearly speech.
 */
export function dropHallucinations<T extends ScoredSegment>(segments: T[]): T[] {
  return segments.filter((s) => {
    const noSpeech = s.no_speech_prob ?? 0;
    const logProb = s.avg_logprob ?? 0;
    if (noSpeech > 0.5 && logProb < -0.5) return false;
    if (noSpeech > 0.3 && HALLUCINATIONS.has(normalizePhrase(s.text))) return false;
    return normalizePhrase(s.text).length > 0;
  });
}

/** True when every sentence of a transcript is one of Whisper's stock phrases ("Thank you."). */
export function isOnlyStockPhrases(text: string): boolean {
  const sentences = text
    .split(/[.!?।\n]+/)
    .map(normalizePhrase)
    .filter(Boolean);
  return sentences.length > 0 && sentences.every((s) => HALLUCINATIONS.has(s));
}

/** Edit distance between two strings (insertions, deletions, substitutions). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");

/**
 * True when two proper names are probably the same word misheard ("Lumena" / "Lumina").
 * Short names must match exactly; longer names tolerate one or two letters.
 */
export function isNearName(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const len = Math.max(x.length, y.length);
  if (len < 5 || x[0] !== y[0]) return false;
  return levenshtein(x, y) <= (len >= 9 ? 2 : 1);
}

export interface Spelling {
  /** How it should be written. */
  canonical: string;
  /** Known alternative spellings that always map to the canonical form. */
  aliases: string[];
}

/**
 * Rewrites capitalised words that are near-misses of known names ("Lumena" → "Lumina"),
 * plus exact alias matches. Only touches capitalised tokens so ordinary words are left alone.
 */
export function applySpellings(text: string, spellings: Spelling[]): string {
  const usable = spellings.filter((s) => squash(s.canonical).length >= 3);
  if (!usable.length) return text;
  return text.replace(/\p{Lu}[\p{L}\p{M}'-]*/gu, (word) => {
    for (const s of usable) {
      if (word === s.canonical) return word;
      if (s.aliases.some((a) => squash(a) === squash(word))) return s.canonical;
      if (!s.canonical.includes(" ") && isNearName(word, s.canonical)) return s.canonical;
    }
    return word;
  });
}
