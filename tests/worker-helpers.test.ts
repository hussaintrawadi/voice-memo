import { describe, expect, it } from "vitest";
import { UnderstandSchema } from "../worker/pipeline/prompts";
import { parseWhen, resolveDayPhrase } from "../worker/lib/time";
import { ftsQuery, fuseRankings } from "../worker/lib/search";
import { applySpellings, chunkText, dropHallucinations, isNameLike, isNearName, isOnlyStockPhrases, levenshtein } from "../worker/lib/text";
import {
  extensionForMime,
  localTime,
  parseModelJson,
  safeEqual,
  stripThinking,
  truncateAndNormalize,
} from "../worker/lib/util";

describe("parseModelJson", () => {
  it("parses plain JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips code fences and thinking blocks", () => {
    expect(parseModelJson('<think>hmm</think>\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it("recovers JSON surrounded by prose", () => {
    expect(parseModelJson('Sure! Here it is: {"a":3} Hope that helps.')).toEqual({ a: 3 });
  });

  it("throws when there is no JSON", () => {
    expect(() => parseModelJson("no json here")).toThrow();
  });
});

describe("stripThinking", () => {
  it("removes every think block", () => {
    expect(stripThinking("<think>a</think>Hello <THINK>b</THINK>world")).toBe("Hello world");
  });
});

describe("truncateAndNormalize", () => {
  it("keeps the prefix and returns a unit vector", () => {
    const v = truncateAndNormalize([3, 4, 100, 100], 2);
    expect(v).toHaveLength(2);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
  });

  it("does not divide by zero", () => {
    expect(truncateAndNormalize([0, 0, 1], 2)).toEqual([0, 0]);
  });
});

describe("localTime", () => {
  it("formats in the user's timezone", () => {
    // 2026-09-17 20:00 UTC is 2026-09-18 01:30 in India.
    const t = localTime(Date.UTC(2026, 8, 17, 20, 0), "Asia/Kolkata");
    expect(t).toEqual({ date: "2026-09-18", weekday: "Friday", time: "01:30" });
  });
});

describe("chunkText", () => {
  it("returns one chunk for short text", () => {
    expect(chunkText("Hello there. How are you?", null, 100)).toEqual(["Hello there. How are you?"]);
  });

  it("splits on segment boundaries without exceeding the limit", () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 1, text: `segment number ${i}` }));
    const chunks = chunkText("", segments, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
    expect(chunks.join(" ")).toBe(segments.map((s) => s.text).join(" "));
  });

  it("hard-splits a single oversized unit", () => {
    const chunks = chunkText("x".repeat(25), null, 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("ftsQuery", () => {
  it("builds a prefix OR query from words", () => {
    expect(ftsQuery("Lumina pricing?")).toBe('"lumina"* OR "pricing"*');
  });

  it("drops punctuation that would break FTS syntax", () => {
    expect(ftsQuery('menu "photos" AND (ocr)')).toBe('"menu"* OR "photos"* OR "and"* OR "ocr"*');
  });

  it("returns null when nothing searchable remains", () => {
    expect(ftsQuery("? ! a")).toBeNull();
  });

  it("keeps Hindi words", () => {
    expect(ftsQuery("मेनू फोटो")).toBe('"मेनू"* OR "फोटो"*');
  });
});

describe("fuseRankings", () => {
  it("ranks items found by several lists first", () => {
    const fused = fuseRankings([
      ["a", "b", "c"],
      ["c", "d"],
    ]);
    expect(fused[0].id).toBe("c");
    expect(fused.map((f) => f.id).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("safeEqual", () => {
  it("compares strings exactly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("extensionForMime", () => {
  it("maps recorder mime types to file extensions providers accept", () => {
    expect(extensionForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionForMime("audio/mp4")).toBe("m4a");
    expect(extensionForMime("audio/ogg")).toBe("ogg");
  });
});

describe("UnderstandSchema", () => {
  it("rejects replies with missing fields", () => {
    expect(UnderstandSchema.safeParse({ title: "x" }).success).toBe(false);
  });

  it("accepts a complete reply", () => {
    const ok = UnderstandSchema.safeParse({
      title: "Menu photo onboarding",
      summary: "s",
      detailed_summary: "d",
      category: "idea",
      language: "hi-en",
      thoughts: [
        {
          type: "idea",
          title: "t",
          summary: "s",
          key_quote: "q",
          project: "Lumina",
          topics: ["onboarding"],
          people: [],
          organizations: [],
          products: [],
          places: [],
        },
      ],
      tasks: [{ title: "Call Priya", due_date: "2026-09-18", due_text: "tomorrow", thought_index: 0 }],
      decisions: [],
      questions: [],
      reminders: [{ text: "Email Priya", remind_at: "2026-09-20T10:00", when_text: "tomorrow at 10", thought_index: 0 }],
      vocabulary: ["Lumina"],
    });
    expect(ok.success).toBe(true);
  });
});

describe("isNameLike", () => {
  it("keeps names and jargon", () => {
    for (const t of ["Lumina", "Priya", "Cloudflare Workers", "GPT-4o", "iOS", "राहुल"]) expect(isNameLike(t)).toBe(true);
  });

  it("drops ordinary words and long phrases", () => {
    for (const t of ["pricing", "automation", "fixed plans", "A Very Long Product Name Here", "x"]) {
      expect(isNameLike(t)).toBe(false);
    }
  });
});

describe("dropHallucinations", () => {
  const seg = (text: string, no_speech_prob: number, avg_logprob: number) => ({ start: 0, end: 1, text, no_speech_prob, avg_logprob });

  it("drops what Whisper invents over silence", () => {
    // Real Groq scores for a silent 52-second recording.
    expect(dropHallucinations([seg(" Thank you.", 0.642, -0.774), seg(" you", 0.701, -0.708)])).toEqual([]);
  });

  it("drops the Welsh phrase Whisper invents over silence", () => {
    // Real Groq scores for a silent 6-second recording.
    expect(dropHallucinations([seg(" Diolch yn fawr iawn am wylio'r fideo.", 0.458, -0.182)])).toEqual([]);
  });

  it("drops stock phrases that aren't clearly speech", () => {
    expect(dropHallucinations([seg("Thanks for watching!", 0.35, -0.3)])).toEqual([]);
  });

  it("keeps real speech, including a genuine thank you", () => {
    const speech = [seg(" I was thinking about Lumina again.", 0.006, -0.15), seg(" Thank you.", 0.01, -0.2)];
    expect(dropHallucinations(speech)).toHaveLength(2);
  });
});

describe("zonedDayStart", () => {
  it("gives midnight in India as UTC", async () => {
    const { zonedDayStart, addDays } = await import("../worker/lib/time");
    expect(new Date(zonedDayStart("2026-09-18", "Asia/Kolkata")).toISOString()).toBe("2026-09-17T18:30:00.000Z");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });

  it("handles a DST day", async () => {
    const { zonedDayStart } = await import("../worker/lib/time");
    expect(new Date(zonedDayStart("2026-03-08", "America/New_York")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(zonedDayStart("2026-03-09", "America/New_York")).toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("isNearName", () => {
  it("matches misheard versions of a name", () => {
    expect(levenshtein("lumena", "lumina")).toBe(1);
    expect(isNearName("Lumena", "Lumina")).toBe(true);
    expect(isNearName("lumina", "Lumina")).toBe(true);
    expect(isNearName("Cloudflair", "Cloudflare")).toBe(true);
  });

  it("does not merge different names", () => {
    expect(isNearName("Nova", "Nov")).toBe(false); // too short to guess
    expect(isNearName("Lumina", "Nimbus")).toBe(false);
    expect(isNearName("Mistral", "Minstrel")).toBe(false); // two edits on a short name is too loose
    expect(isNearName("Groq", "Grok")).toBe(false);
  });
});

describe("applySpellings", () => {
  const spellings = [
    { canonical: "Lumina", aliases: ["Luminar"] },
    { canonical: "Priya", aliases: ["Priyaa"] },
  ];

  it("fixes misheard project names and known aliases", () => {
    expect(applySpellings("I was thinking about Lumena again. Call Priyaa about Luminar.", spellings)).toBe(
      "I was thinking about Lumina again. Call Priya about Lumina.",
    );
  });

  it("leaves ordinary words alone", () => {
    expect(applySpellings("We need to review the rotation plan.", spellings)).toBe("We need to review the rotation plan.");
  });
});

describe("isOnlyStockPhrases", () => {
  it("spots transcripts made only of Whisper's filler", () => {
    expect(isOnlyStockPhrases("Thank you.")).toBe(true);
    expect(isOnlyStockPhrases("Thank you. Thanks for watching!")).toBe(true);
    expect(isOnlyStockPhrases("धन्यवाद।")).toBe(true);
  });
  it("keeps real speech", () => {
    expect(isOnlyStockPhrases("Thank you. Remind me to call Priya tomorrow.")).toBe(false);
    expect(isOnlyStockPhrases("")).toBe(false);
  });
});

describe("parseWhen", () => {
  it("reads local wall-clock time in the user's timezone", () => {
    expect(parseWhen("2026-09-20T10:00", "Asia/Kolkata")).toBe(Date.UTC(2026, 8, 20, 4, 30));
    expect(parseWhen("2026-03-08T03:30", "America/New_York")).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });
  it("keeps explicit offsets", () => {
    expect(parseWhen("2026-09-20T10:00:00Z", "Asia/Kolkata")).toBe(Date.UTC(2026, 8, 20, 10, 0));
    expect(parseWhen("2026-09-20T10:00+05:30", "UTC")).toBe(Date.UTC(2026, 8, 20, 4, 30));
  });
  it("rejects nonsense", () => {
    expect(() => parseWhen("tomorrow", "Asia/Kolkata")).toThrow();
  });
});

describe("resolveDayPhrase", () => {
  // Saturday 26 Sep 2026
  const sat = "2026-09-26";
  it("reads weekdays as the nearest one, today included", () => {
    expect(resolveDayPhrase("by Thursday", sat)).toBe("2026-10-01");
    expect(resolveDayPhrase("on Monday", sat)).toBe("2026-09-28");
    expect(resolveDayPhrase("this Saturday", sat)).toBe("2026-09-26");
    expect(resolveDayPhrase("Thursday", "2026-09-21")).toBe("2026-09-24"); // said on a Monday
  });
  it("reads 'next <weekday>' as the following week's", () => {
    expect(resolveDayPhrase("next Thursday", sat)).toBe("2026-10-01");
    expect(resolveDayPhrase("next Thursday", "2026-09-21")).toBe("2026-10-01"); // Monday → a week on
    expect(resolveDayPhrase("next Sunday", sat)).toBe("2026-10-04");
  });
  it("reads relative days, in English and Hindi", () => {
    expect(resolveDayPhrase("tomorrow", sat)).toBe("2026-09-27");
    expect(resolveDayPhrase("kal", sat)).toBe("2026-09-27");
    expect(resolveDayPhrase("parso", sat)).toBe("2026-09-28");
    expect(resolveDayPhrase("guruvar tak", sat)).toBe("2026-10-01");
    expect(resolveDayPhrase("tonight", sat)).toBe(sat);
    expect(resolveDayPhrase("in 3 days", sat)).toBe("2026-09-29");
  });
  it("leaves phrases it can't pin down to the model", () => {
    expect(resolveDayPhrase("by the end of the month", sat)).toBeNull();
    expect(resolveDayPhrase("on the 3rd of October", sat)).toBeNull();
    expect(resolveDayPhrase("month end", sat)).toBeNull();
  });
});
