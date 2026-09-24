import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { ApiError } from "./lib/api";
import { startConnectivityWatcher } from "./lib/online";
import { isNativeApp } from "./lib/platform";
import { kvStorage, startQueueWorker } from "./lib/queue";
import "./index.css";

/**
 * How long memos stay readable offline. Must stay under ~24.8 days: timers longer than
 * 2^31-1 ms fire immediately, which would wipe the restored cache on startup.
 */
const OFFLINE_CACHE_MS = 20 * 24 * 3600_000;
/** Queries that are only useful live and shouldn't be kept for offline reading. */
const LIVE_ONLY = new Set(["status", "search", "sessions", "vocabulary", "capture-tokens"]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
      // Keep cached memos around so they can be read offline.
      gcTime: OFFLINE_CACHE_MS,
      networkMode: "offlineFirst",
    },
  },
});

const persister = createAsyncStoragePersister({ storage: kvStorage, key: "vm-query-cache", throttleTime: 2000 });

startConnectivityWatcher();
// The Android app ships its UI inside the package and records natively,
// so the service worker and the browser upload queue are web-only.
if (!isNativeApp) {
  registerSW({ immediate: true });
  startQueueWorker();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: OFFLINE_CACHE_MS,
        buster: "v2",
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => q.state.status === "success" && !LIVE_ONLY.has(String(q.queryKey[0])),
        },
      }}
    >
      <App />
    </PersistQueryClientProvider>
  </StrictMode>,
);
