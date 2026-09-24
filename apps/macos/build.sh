#!/usr/bin/env bash
# Builds "build/Voice Memo.app" (ad-hoc signed: runs on this Mac without an Apple developer account).
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release
APP="build/Voice Memo.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/VoiceMemo "$APP/Contents/MacOS/VoiceMemo"
cp Info.plist "$APP/Contents/Info.plist"
# Your deployed Worker, e.g. https://voice-memo.<you>.workers.dev (or put it in ../../.voice-memo-url).
SERVER_URL="${VOICE_MEMO_URL:-$(cat ../../.voice-memo-url 2>/dev/null || true)}"
if [[ -z "$SERVER_URL" ]]; then
  echo "Set VOICE_MEMO_URL or write your Worker URL to .voice-memo-url" >&2
  exit 1
fi
/usr/libexec/PlistBuddy -c "Add :VoiceMemoServerURL string $SERVER_URL" "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - --timestamp=none "$APP"
echo "Built: $(pwd)/$APP"
