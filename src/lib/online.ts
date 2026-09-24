import { Network } from "@capacitor/network";
import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { isNativeApp } from "./platform";

/**
 * Connectivity for the whole app. The Android WebView's navigator.onLine is unreliable,
 * so the app build asks the OS instead; React Query pauses and resumes requests with it.
 */
export function startConnectivityWatcher() {
  if (!isNativeApp) return;
  onlineManager.setEventListener((setOnline) => {
    void Network.getStatus().then((s) => setOnline(s.connected));
    const handle = Network.addListener("networkStatusChange", (s) => setOnline(s.connected));
    return () => void handle.then((h) => h.remove());
  });
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
  );
}
