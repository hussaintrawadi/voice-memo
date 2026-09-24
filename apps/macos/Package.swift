// swift-tools-version: 5.10
import PackageDescription

// Voice Memo for macOS: the web app in a native window, plus a menu-bar recorder with a
// global shortcut and an offline upload queue. Build with ./build.sh (makes "Voice Memo.app").
let package = Package(
    name: "VoiceMemo",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "VoiceMemo",
            path: "Sources/VoiceMemo",
            linkerSettings: [.linkedFramework("Carbon")]
        ),
    ]
)
