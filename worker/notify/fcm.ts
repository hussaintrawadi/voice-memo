/**
 * Firebase Cloud Messaging (HTTP v1), used to push reminders to the Android app. Free, no card.
 * Auth: a service account's private key signs a JWT, exchanged for a 1-hour access token.
 * The key lives in the FCM_SERVICE_ACCOUNT secret (the downloaded JSON, as one string).
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag (e.g. a snoozed reminder). */
  tag: string;
  data: Record<string, string>;
}

export type PushOutcome = "sent" | "unregistered" | "retry" | "failed";

let cached: { token: string; expiresAt: number; email: string } | null = null;

function parseAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const account = JSON.parse(raw) as ServiceAccount;
    return account.project_id && account.client_email && account.private_key ? account : null;
  } catch {
    return null;
  }
}

export const pushConfigured = (env: Env) => parseAccount(env.FCM_SERVICE_ACCOUNT) !== null;

const base64url = (data: ArrayBuffer | string) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function accessToken(account: ServiceAccount): Promise<string> {
  if (cached && cached.email === account.client_email && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    }),
  )}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000, email: account.client_email };
  return body.access_token;
}

export async function sendPush(env: Env, message: PushMessage): Promise<PushOutcome> {
  const account = parseAccount(env.FCM_SERVICE_ACCOUNT);
  if (!account) return "failed";
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(account)}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: {
          priority: "HIGH",
          ttl: "86400s",
          notification: { channel_id: "reminders", tag: message.tag, default_sound: true },
        },
      },
    }),
  });
  if (res.ok) return "sent";
  // 404 UNREGISTERED / 400 on a dead token: the app was uninstalled or its token rotated.
  if (res.status === 404 || res.status === 400) return "unregistered";
  if (res.status === 429 || res.status >= 500) return "retry";
  if (res.status === 401) cached = null;
  console.error("fcm send failed", res.status, (await res.text()).slice(0, 300));
  return "failed";
}
