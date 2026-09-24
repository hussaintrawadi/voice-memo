import Foundation

/// A recording waiting to be uploaded: an .m4a file plus a small .json sidecar.
struct PendingItem: Codable, Identifiable, Equatable {
    var id: String
    var recordedAt: Int64
    var durationSec: Double
    var bytes: Int64
    var partOf: String
    var partIndex: Int
    /// Loudest moment, 0–1 (lets the server skip silent recordings).
    var peak: Double
    var attempts: Int = 0
    var lastError: String?
    var blocked: Bool = false
}

enum PendingStore {
    static func audioURL(_ id: String) -> URL { Config.recordingsDirectory.appendingPathComponent("\(id).m4a") }
    private static func metaURL(_ id: String) -> URL { Config.recordingsDirectory.appendingPathComponent("\(id).json") }

    static func save(_ item: PendingItem) throws {
        let data = try JSONEncoder().encode(item)
        try data.write(to: metaURL(item.id), options: .atomic)
    }

    static func list() -> [PendingItem] {
        let files = (try? FileManager.default.contentsOfDirectory(at: Config.recordingsDirectory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { url -> PendingItem? in
                guard let data = try? Data(contentsOf: url), let item = try? JSONDecoder().decode(PendingItem.self, from: data) else { return nil }
                guard FileManager.default.fileExists(atPath: audioURL(item.id).path) else {
                    try? FileManager.default.removeItem(at: url)
                    return nil
                }
                return item
            }
            .sorted { $0.recordedAt < $1.recordedAt }
    }

    static func delete(_ id: String) {
        try? FileManager.default.removeItem(at: audioURL(id))
        try? FileManager.default.removeItem(at: metaURL(id))
    }
}
