import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android app: the React UI is bundled into the APK (works offline) and talks to the
 * Cloudflare API over HTTPS with a bearer token. Build with `npm run android:build`.
 */
const config: CapacitorConfig = {
  appId: "app.voicememo.personal",
  appName: "Voice Memo",
  webDir: "dist/client",
  android: {
    allowMixedContent: false,
    backgroundColor: "#f6f4ef",
  },
  plugins: {
    // Keep the WebView's own fetch; the API sends CORS headers for https://localhost.
    CapacitorHttp: { enabled: false },
  },
};

export default config;
