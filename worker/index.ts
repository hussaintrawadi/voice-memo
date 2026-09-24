import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { app } from "./app";
import { runScheduled } from "./cron";
import { authorizeHandler, SCOPES } from "./mcp/authorize";
import { mcpApiHandler } from "./mcp/server";

export { ProcessRecording } from "./pipeline/workflow";

/**
 * OAuth 2.1 in front of the Claude connector: /mcp needs a token granted on /authorize.
 * Everything else (the app's own API) passes straight through to the Hono app.
 */
const oauth = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: {
    fetch(request, env, ctx) {
      if (new URL(request.url).pathname === "/authorize") return authorizeHandler(request, env as Parameters<typeof authorizeHandler>[1]);
      return app.fetch(request, env, ctx);
    },
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: SCOPES,
  accessTokenTTL: 3600,
});

export default {
  fetch: (request, env, ctx) => oauth.fetch(request, env, ctx),
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
