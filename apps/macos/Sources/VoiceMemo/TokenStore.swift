import Foundation

/// The device upload token, kept in a file only this user can read. Not the keychain: the app is
/// ad-hoc signed, so macOS treats every rebuild as a new app and would ask for the keychain password.
/// The token can only upload recordings, and it can be revoked from Settings in the web app.
enum TokenStore {
    struct Stored: Codable {
        /// Server-side id, used to revoke the token on sign-out.
        var id: String?
        var token: String
    }

    private static var url: URL { Config.supportDirectory.appendingPathComponent("upload-token.json") }

    static func get() -> Stored? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    static func set(_ value: Stored?) {
        try? FileManager.default.removeItem(at: url)
        guard let value, let data = try? JSONEncoder().encode(value) else { return }
        FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])
    }
}
