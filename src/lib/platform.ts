import { Capacitor } from "@capacitor/core";

/** True inside the packaged Android app (the UI is bundled; the API is remote). */
export const isNativeApp = Capacitor.isNativePlatform();

interface MacMessageHandler {
  postMessage(body: unknown): Promise<unknown>;
}

/** The Mac app's bridge (apps/macos WebBridge.swift), present only inside its window. */
export const macBridge: MacMessageHandler | undefined = (
  window as { webkit?: { messageHandlers?: { voiceMemoMac?: MacMessageHandler } } }
).webkit?.messageHandlers?.voiceMemoMac;

/** True inside the Mac app's window: the web app is loaded from the server, but recording is native. */
export const isMacApp = !isNativeApp && macBridge !== undefined;

/** Production API origin baked into app builds; empty for the web app (same origin). */
export const API_BASE: string = isNativeApp ? (import.meta.env.VITE_API_BASE ?? "") : "";

export const CLIENT_LABEL = isNativeApp ? `${Capacitor.getPlatform() === "android" ? "Android" : "Mobile"} app` : null;

const TOKEN_KEY = "vm_token";

/** Bearer session token, used only by the packaged app (browsers use an HttpOnly cookie). */
export const sessionStore = {
  get: (): string | null => (isNativeApp ? localStorage.getItem(TOKEN_KEY) : null),
  set: (token: string | null) => {
    if (!isNativeApp) return;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

export const apiUrl = (path: string) => `${API_BASE}${path}`;
