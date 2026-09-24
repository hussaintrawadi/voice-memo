#!/usr/bin/env bash
# Builds a signed Android APK: bundles the UI, syncs it into the Android project, runs Gradle.
# Usage: scripts/android-build.sh            -> android/app/build/outputs/apk/release/app-release.apk
set -euo pipefail
cd "$(dirname "$0")/.."

# Your deployed Worker, e.g. https://voice-memo.<you>.workers.dev (or put it in .voice-memo-url).
API_BASE="${VITE_API_BASE:-$(cat .voice-memo-url 2>/dev/null || true)}"
if [[ -z "$API_BASE" ]]; then
  echo "Set VITE_API_BASE or write your Worker URL to .voice-memo-url" >&2
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
# Capacitor 8 needs Java 21; Android Studio ships one.
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" ]] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -q '"21'; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi

KEYSTORE=android/voice-memo-release.keystore
PROPS=android/keystore.properties
if [[ ! -f "$KEYSTORE" ]]; then
  echo "Creating a signing key (kept locally, never committed)…"
  PASS=$(openssl rand -hex 24)
  "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore "$KEYSTORE" -alias voicememo -keyalg RSA -keysize 2048 \
    -validity 36500 -storepass "$PASS" -keypass "$PASS" -dname "CN=Voice Memo, O=Personal" >/dev/null
  umask 077
  printf 'storeFile=../voice-memo-release.keystore\nstorePassword=%s\nkeyAlias=voicememo\nkeyPassword=%s\n' "$PASS" "$PASS" > "$PROPS"
fi

VITE_API_BASE="$API_BASE" npx vite build
npx cap sync android
(cd android && ./gradlew --quiet assembleRelease)
echo "APK: android/app/build/outputs/apk/release/app-release.apk"
