import { api, json } from "./api";
import { callMac, NativeRecorder } from "./native";
import { API_BASE, CLIENT_LABEL, isMacApp, isNativeApp, sessionStore } from "./platform";

const CAPTURE_TOKEN_ID_KEY = "vm_capture_token_id";

/**
 * The Android app uploads recordings in the background with its own device token,
 * so uploads keep working even if the app isn't open. Created once per install.
 */
async function ensureDeviceToken() {
  if (!isNativeApp) return;
  const config = await NativeRecorder.getConfig();
  if (config.hasToken && config.baseUrl === API_BASE) return;
  const { id, token } = await api<{ id: string; token: string }>("/capture-tokens", {
    method: "POST",
    body: json({ label: CLIENT_LABEL ?? "App" }),
  });
  localStorage.setItem(CAPTURE_TOKEN_ID_KEY, id);
  await NativeRecorder.configure({ baseUrl: API_BASE, captureToken: token });
}

async function signedIn(token: string) {
  sessionStore.set(token);
  await ensureDeviceToken();
  // The Mac app makes its own upload token from this session; let it start uploading now.
  if (isMacApp) void callMac("signedIn").catch(() => undefined);
}

export async function setupAccount(input: { name: string; email: string; password: string; setupCode: string }) {
  const { token } = await api<{ token: string }>("/auth/setup", { method: "POST", body: json(input) });
  await signedIn(token);
}

export async function login(input: { email: string; password: string }) {
  const { token } = await api<{ token: string }>("/auth/login", { method: "POST", body: json(input) });
  await signedIn(token);
}

export async function resetPassword(input: { email: string; setupCode: string; newPassword: string }) {
  const { token } = await api<{ token: string }>("/auth/reset", { method: "POST", body: json(input) });
  await signedIn(token);
}

export async function logout() {
  if (isNativeApp) {
    const tokenId = localStorage.getItem(CAPTURE_TOKEN_ID_KEY);
    if (tokenId) await api(`/capture-tokens/${tokenId}`, { method: "DELETE" }).catch(() => undefined);
    localStorage.removeItem(CAPTURE_TOKEN_ID_KEY);
    await NativeRecorder.configure({ baseUrl: API_BASE, captureToken: null });
  }
  // Revokes the Mac app's upload token; needs the session, so it runs before logging out.
  if (isMacApp) await callMac("signOut").catch(() => undefined);
  await api("/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
  sessionStore.set(null);
}

/** Re-checks the device token on start (e.g. after an app update or reinstall). */
export function refreshDeviceToken() {
  if (sessionStore.get()) void ensureDeviceToken().catch(() => undefined);
}
