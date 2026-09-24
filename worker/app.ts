import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { authRoutes, requireSession } from "./auth";
import { HttpError } from "./lib/util";
import { connectionRoutes } from "./routes/connections";
import { miscRoutes } from "./routes/misc";
import { projectRoutes } from "./routes/projects";
import { recordingRoutes } from "./routes/recordings";
import { deviceReminderRoutes, pushDeviceRoutes, reminderRoutes } from "./routes/reminders";
import { summaryRoutes } from "./routes/summaries";

export interface AppEnv {
  Bindings: Env;
  Variables: { userId: string; sessionId: string };
}

/** Origins of the packaged apps (Capacitor serves the bundled UI from https://localhost). */
const APP_ORIGINS = new Set(["https://localhost", "capacitor://localhost", "http://localhost"]);

/**
 * Paths reachable without a session (they do their own auth):
 * auth itself, device-token endpoints (capture, reminder sync) and signed audio links.
 */
const PUBLIC = [/^\/api\/auth\//, /^\/api\/capture$/, /^\/api\/device\/reminders$/, /^\/api\/health$/];
const SIGNED_AUDIO = /^\/api\/recordings\/[^/]+\/audio$/;

export const app = new Hono<AppEnv>().basePath("/api");

app.use(
  "*",
  cors({
    origin: (origin) => (APP_ORIGINS.has(origin) ? origin : null),
    allowHeaders: [
      "authorization",
      "content-type",
      "x-client",
      "x-recorded-at",
      "x-duration-sec",
      "x-part-of",
      "x-part-index",
      "x-source",
      "x-recording-id",
      "x-audio-peak",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
  }),
);

app.use("*", async (c, next) => {
  const path = c.req.path;
  if (PUBLIC.some((re) => re.test(path))) return next();
  if (SIGNED_AUDIO.test(path) && c.req.query("sig")) return next();
  return requireSession(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);
app.route("/recordings", recordingRoutes);
app.route("/projects", projectRoutes);
app.route("/summaries", summaryRoutes);
app.route("/reminders", reminderRoutes);
app.route("/push-devices", pushDeviceRoutes);
app.route("/connections", connectionRoutes);
app.route("/device/reminders", deviceReminderRoutes);
app.route("/", miscRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join(".");
    return c.json({ error: first ? `${field ? `${field}: ` : ""}${first.message}` : "Invalid request" }, 400);
  }
  console.error("unhandled", err);
  return c.json({ error: "Something went wrong on the server" }, 500);
});
