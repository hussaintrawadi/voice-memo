import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { HttpError } from "../lib/util";

/** Apps connected through the Claude connector (OAuth grants), so the owner can see and revoke them. */
const helpers = (env: Env) => {
  const h = (env as Env & { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;
  if (!h) throw new HttpError(503, "Connections aren't available here");
  return h;
};

export const connectionRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { items } = await helpers(c.env).listUserGrants(c.get("userId"));
    return c.json({
      connections: items.map((g) => ({
        id: g.id,
        name: (g.metadata as { clientName?: string } | null)?.clientName ?? "App",
        // The provider stores seconds; the app uses milliseconds everywhere.
        createdAt: g.createdAt < 1e12 ? g.createdAt * 1000 : g.createdAt,
      })),
    });
  })
  .delete("/:id", async (c) => {
    await helpers(c.env).revokeGrant(c.req.param("id"), c.get("userId"));
    return c.json({ ok: true });
  });
