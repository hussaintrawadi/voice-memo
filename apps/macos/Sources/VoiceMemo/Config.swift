import Foundation

enum Config {
    /// The deployed Worker, written into Info.plist by build.sh (from .voice-memo-url).
    static let productionURL: URL = (Bundle.main.object(forInfoDictionaryKey: "VoiceMemoServerURL") as? String)
        .flatMap(URL.init(string:)) ?? URL(string: "http://localhost:5174")!

    /// The Voice Memo server: the window loads it and uploads go to its /api/capture.
    /// For testing, launch with `-baseURL http://localhost:5174` (not saved between launches).
    static let baseURL: URL = UserDefaults.standard.string(forKey: "baseURL").flatMap(URL.init(string:)) ?? productionURL

    /// A test server gets its own recordings and token, so nothing mixes with real memos.
    static var isTestServer: Bool { baseURL != productionURL }

    static let clientLabel = "Mac app"

    /// ~/Library/Application Support/Voice Memo (private to this user).
    static var supportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent(isTestServer ? "Voice Memo (test)" : "Voice Memo", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return dir
    }

    /// ~/Library/Application Support/Voice Memo/Recordings
    static var recordingsDirectory: URL {
        let dir = supportDirectory.appendingPathComponent("Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
