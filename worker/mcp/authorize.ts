import { type AuthRequest, AuthorizationError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { ownerForSessionCookie, verifyOwnerLogin } from "../auth";
import { signPayload, verifyPayload } from "../lib/secrets";
import { HttpError } from "../lib/util";

/**
 * The consent screen shown when Claude (or another MCP client) asks to connect.
 * Access is granted only after the owner signs in here (or is already signed in in this browser).
 */

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const SCOPES = ["memory"];
const PURPOSE = "oauth-consent";
const FORM_TTL_MS = 10 * 60_000;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Voice Memo</title>
<style>
:root{--bg:#F6F4EF;--card:#fff;--ink:#1d1b18;--muted:#6b665d;--brand:#1F3D35;--accent:#E4572E;--line:#e5e1d8}
@media (prefers-color-scheme:dark){:root{--bg:#131311;--card:#1c1c1a;--ink:#f1eee7;--muted:#a19c92;--line:#2c2b28}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px}
.logo{width:48px;height:48px;border-radius:14px;background:var(--brand);display:grid;place-items:center;margin-bottom:16px}
h1{font:600 22px/1.3 Georgia,serif;margin:0 0 8px}p{margin:0 0 12px;color:var(--muted);font-size:15px}
ul{margin:0 0 20px;padding-left:20px;color:var(--muted);font-size:14px}
label{display:block;font-size:14px;font-weight:500;margin:12px 0 4px}
input{width:100%;height:44px;border:1px solid var(--line);border-radius:12px;padding:0 12px;background:transparent;color:var(--ink);font-size:16px}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;height:46px;border-radius:999px;border:0;font-size:15px;font-weight:600;cursor:pointer}
.allow{background:var(--brand);color:#fff}.deny{background:transparent;color:var(--muted);border:1px solid var(--line)}
.err{background:#e4572e1a;color:var(--accent);border-radius:12px;padding:10px 12px;font-size:14px;margin-bottom:12px}
</style></head><body><main class="card">
<div class="logo"><svg width="26" height="26" viewBox="0 0 108 108"><circle cx="54" cy="54" r="30" fill="#F6F4EF"/><g fill="#E4572E"><rect x="37" y="47" width="5" height="14" rx="2.5"/><rect x="46" y="40" width="5" height="28" rx="2.5"/><rect x="55" y="35" width="5" height="38" rx="2.5"/><rect x="64" y="44" width="5" height="20" rx="2.5"/></g></svg></div>
${body}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function consentForm(clientName: string, signed: string, signedInAs: string | null, error?: string): Response {
  const name = escapeHtml(clientName);
  return page(
    `Connect ${clientName}`,
    `<h1>Connect ${name} to Voice Memo</h1>
<p>${name} will be able to:</p>
<ul><li>Read your memos, thoughts, projects, action points and summaries</li><li>Add notes, action points and reminders for you</li></ul>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escapeHtml(signed)}">
${
  signedInAs
    ? `<p>Signed in as <strong>${escapeHtml(signedInAs)}</strong>.</p>`
    : `<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>`
}
<div class="row"><button class="deny" name="decision" value="deny">Cancel</button><button class="allow" name="decision" value="allow">Allow</button></div>
</form>`,
  );
}

function errorRedirect(request: AuthRequest, code: string, description: string): Response {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  if (request.state) url.searchParams.set("state", request.state);
  const issuer = (request as AuthRequest & { issuer?: string }).issuer;
  if (issuer) url.searchParams.set("iss", issuer);
  return Response.redirect(url.toString(), 302);
}

async function clientName(env: OAuthEnv, clientId: string): Promise<string> {
  const client = await env.OAUTH_PROVIDER.lookupClient(clientId);
  return client?.clientName?.trim() || "An app";
}

export async function authorizeHandler(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method === "GET") {
    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (err) {
      if (!(err instanceof AuthorizationError)) throw err;
      if (!err.redirectUri) return page("Can't connect", `<h1>Can't connect</h1><p>${escapeHtml(err.description)}</p>`, 400);
      const url = new URL(err.redirectUri);
      url.searchParams.set("error", err.code);
      url.searchParams.set("error_description", err.description);
      if (err.state) url.searchParams.set("state", err.state);
      if (err.issuer) url.searchParams.set("iss", err.issuer);
      return Response.redirect(url.toString(), 302);
    }
    if (!(await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId))) {
      return page("Can't connect", "<h1>Can't connect</h1><p>This app isn't registered.</p>", 400);
    }
    const owner = await ownerForSessionCookie(env, request.headers.get("cookie"));
    const signed = await signPayload(env, PURPOSE, oauthRequest, FORM_TTL_MS);
    return consentForm(await clientName(env, oauthRequest.clientId), signed, owner?.email ?? null);
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  // The form only ever posts from this page.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return page("Can't connect", "<h1>Can't connect</h1><p>Please start again from the app.</p>", 403);

  const form = await request.formData();
  const signed = String(form.get("request") ?? "");
  const oauthRequest = await verifyPayload<AuthRequest>(env, PURPOSE, signed);
  if (!oauthRequest) {
    return page("Expired", "<h1>This page expired</h1><p>Go back to the app and connect again.</p>", 400);
  }
  if (form.get("decision") !== "allow") return errorRedirect(oauthRequest, "access_denied", "You declined the connection");

  const name = await clientName(env, oauthRequest.clientId);
  // Signed-in browser (the cookie is SameSite=Lax, so a cross-site post can't carry it) or email + password.
  let owner = await ownerForSessionCookie(env, request.headers.get("cookie"));
  if (!owner) {
    try {
      owner = await verifyOwnerLogin(
        env,
        String(form.get("email") ?? ""),
        String(form.get("password") ?? ""),
        request.headers.get("cf-connecting-ip") ?? "local",
      );
    } catch (err) {
      const message = err instanceof HttpError ? err.message : "Couldn't sign you in";
      const fresh = await signPayload(env, PURPOSE, oauthRequest, FORM_TTL_MS);
      return consentForm(name, fresh, null, message);
    }
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: owner.id,
    metadata: { clientName: name, connectedAt: Date.now() },
    scope: SCOPES,
    props: { userId: owner.id },
  });
  return Response.redirect(redirectTo, 302);
}
