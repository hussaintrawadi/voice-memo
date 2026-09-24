import Foundation
import Network
import WebKit

/// Uploads queued recordings to /api/capture whenever the Mac is online, with backoff on failures.
/// Uses a per-device upload token (see TokenStore), created from the window's sign-in session.
@MainActor
final class Uploader: ObservableObject {
    @Published private(set) var pending: [PendingItem] = []
    @Published private(set) var needsSignIn = false
    @Published private(set) var online = true
    @Published private(set) var uploading = false

    private let monitor = NWPathMonitor()
    private var retryTask: Task<Void, Never>?
    private var retryDelay: TimeInterval = 30

    init() {
        refresh()
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let isOnline = path.status == .satisfied
                let cameOnline = isOnline && !self.online
                self.online = isOnline
                if cameOnline { self.kick() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "voice-memo.network"))
        kick()
    }

    /// Re-reads the queue from disk; publishes only when it actually changed.
    func refresh() {
        let items = PendingStore.list()
        if items != pending { pending = items }
    }

    /// Try to upload now (after a recording, on reconnect, or after signing in).
    func kick() {
        retryTask?.cancel()
        Task { await run() }
    }

    func retryBlocked() {
        for var item in PendingStore.list() where item.blocked {
            item.blocked = false
            item.lastError = nil
            try? PendingStore.save(item)
        }
        kick()
    }

    func delete(_ id: String) {
        PendingStore.delete(id)
        refresh()
    }

    private func run() async {
        guard !uploading else { return }
        refresh()
        guard !pending.isEmpty else { return }
        uploading = true
        defer {
            uploading = false
            refresh()
        }

        guard let token = await ensureToken() else {
            needsSignIn = true
            return
        }
        needsSignIn = false

        for var item in PendingStore.list() where !item.blocked {
            let outcome = await upload(item, token: token)
            switch outcome {
            case .done:
                PendingStore.delete(item.id)
                retryDelay = 30
            case .signedOut:
                TokenStore.set(nil)
                needsSignIn = true
                return
            case let .permanent(message):
                item.attempts += 1
                item.lastError = message
                item.blocked = true
                try? PendingStore.save(item)
            case let .retry(message):
                item.attempts += 1
                item.lastError = message
                try? PendingStore.save(item)
                scheduleRetry()
                return
            }
            refresh()
        }
    }

    private func scheduleRetry() {
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, 15 * 60)
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.run()
        }
    }

    private enum Outcome {
        case done
        case signedOut
        case permanent(String)
        case retry(String)
    }

    private func upload(_ item: PendingItem, token: String) async -> Outcome {
        var request = URLRequest(url: Config.baseURL.appendingPathComponent("api/capture"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.setValue(item.id, forHTTPHeaderField: "X-Recording-Id")
        request.setValue(String(item.recordedAt), forHTTPHeaderField: "X-Recorded-At")
        request.setValue(String(item.durationSec), forHTTPHeaderField: "X-Duration-Sec")
        request.setValue("mac", forHTTPHeaderField: "X-Source")
        request.setValue(item.partOf, forHTTPHeaderField: "X-Part-Of")
        request.setValue(String(item.partIndex), forHTTPHeaderField: "X-Part-Index")
        request.setValue(String(item.peak), forHTTPHeaderField: "X-Audio-Peak")
        do {
            let (data, response) = try await URLSession.shared.upload(for: request, fromFile: PendingStore.audioURL(item.id))
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) { return .done }
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Upload failed (\(status))"
            if status == 401 { return .signedOut }
            if [400, 409, 413, 415].contains(status) { return .permanent(message) }
            return .retry(message)
        } catch {
            return .retry("No connection to Voice Memo")
        }
    }

    /// Revokes this Mac's upload token while the window's session is still valid, then forgets it.
    func signOut() async {
        if let id = TokenStore.get()?.id, let session = await sessionCookie() {
            var request = URLRequest(url: Config.baseURL.appendingPathComponent("api/capture-tokens/\(id)"))
            request.httpMethod = "DELETE"
            request.setValue("vm_session=\(session)", forHTTPHeaderField: "Cookie")
            _ = try? await URLSession.shared.data(for: request)
        }
        TokenStore.set(nil)
        refresh()
        needsSignIn = !pending.isEmpty
    }

    private func sessionCookie() async -> String? {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        return cookies.first(where: {
            $0.name == "vm_session" && Config.baseURL.host?.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == true
        })?.value
    }

    /// The stored token, or a new one created with the window's signed-in session.
    func ensureToken() async -> String? {
        if let stored = TokenStore.get() { return stored.token }
        guard let session = await sessionCookie() else { return nil }
        var request = URLRequest(url: Config.baseURL.appendingPathComponent("api/capture-tokens"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("vm_session=\(session)", forHTTPHeaderField: "Cookie")
        request.setValue(Config.clientLabel, forHTTPHeaderField: "X-Client")
        request.httpBody = try? JSONEncoder().encode(["label": Config.clientLabel])
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 201,
              let body = try? JSONDecoder().decode([String: String].self, from: data),
              let token = body["token"]
        else { return nil }
        TokenStore.set(.init(id: body["id"], token: token))
        return token
    }
}
