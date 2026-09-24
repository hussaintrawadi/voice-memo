import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { summarizeRange } from "../insights/summaries";
import { isIsoDate } from "../lib/time";
import { HttpError } from "../lib/util";

const MAX_RANGE_DAYS = 366;

const RangeBody = z.object({
  start: z.string().refine(isIsoDate, "Use YYYY-MM-DD"),
  end: z.string().refine(isIsoDate, "Use YYYY-MM-DD"),
  refresh: z.boolean().optional(),
});

export const summaryRoutes = new Hono<AppEnv>()
  .post("/", async (c) => {
    const body = RangeBody.parse(await c.req.json());
    if (body.end < body.start) throw new HttpError(400, "The end date is before the start date");
    const days = (Date.parse(body.end) - Date.parse(body.start)) / 86_400_000 + 1;
    if (days > MAX_RANGE_DAYS) throw new HttpError(400, "Pick a range of a year or less");
    return c.json(await summarizeRange(c.env, c.get("userId"), body.start, body.end, { refresh: body.refresh }));
  })

  .get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, start_date, end_date, json_extract(content, '$.headline') AS headline, source_count, created_at
       FROM range_summaries WHERE user_id = ? ORDER BY created_at DESC LIMIT 12`,
    )
      .bind(c.get("userId"))
      .all();
    return c.json({ summaries: results });
  });
