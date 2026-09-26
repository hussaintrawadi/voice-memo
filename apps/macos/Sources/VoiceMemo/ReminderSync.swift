import AppKit
import UserNotifications

extension Notification.Name {
    /// Ask the app to show its main window (handled by a view that can call openWindow).
    static let openMainWindow = Notification.Name("VoiceMemoOpenMainWindow")
}

/// Rings reminders on this Mac. The list comes from the server with the device upload token every
/// 5 minutes, on wake, and whenever the page changes a reminder. The app (always running in the menu
/// bar) keeps its own timer for the next one and, when it's due, shows a floating alert with a
/// repeating sound until you press Done or Snooze. Reminders missed while the Mac slept are shown
/// when it wakes.
@MainActor
final class ReminderSync: NSObject, UNUserNotificationCenterDelegate {
    private struct Item: Decodable, Equatable {
        let id: String
        let text: String
        let remindAt: Double
        let recordingId: String?
    }

    private struct Response: Decodable {
        let reminders: [Item]
    }

    /// Scheduled notifications from earlier builds used this prefix; they're removed on launch.
    private static let legacyPrefix = "reminder-"
    /// "id@time" of reminders already rung or shown, so each rings once per time it's set for.
    private static let handledKey = "handledReminderTimes"
    private static let snoozeMinutes = 10

    private let uploader: Uploader
    private let center = UNUserNotificationCenter.current()
    private let alarms = AlarmPanel()
    private var syncTimer: Timer?
    private var nextTimer: Timer?
    private var syncing = false
    private var upcoming: [Item] = []
    /// Snoozes made here, kept until the server reports the new time (or the reminder is gone).
    private var snoozed: [String: Item] = [:]
    /// Opens a path such as /r/<memo id> in the window.
    var openPath: ((String) -> Void)?

    init(uploader: Uploader) {
        self.uploader = uploader
        super.init()
        center.delegate = self
        alarms.onDone = { [weak self] alert in self?.send(alert.id, action: "done") }
        alarms.onSnooze = { [weak self] alert in self?.snooze(alert) }
        alarms.onOpen = { [weak self] alert in
            self?.send(alert.id, action: "done")
            NotificationCenter.default.post(name: .openMainWindow, object: nil)
            NSApp.activate(ignoringOtherApps: true)
            self?.openPath?(alert.recordingId.map { "/r/\($0)" } ?? "/")
        }
        syncTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.sync() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.sync() }
        }
        // Earlier builds scheduled macOS notifications; the app rings reminders itself now.
        Task { @MainActor in
            let old = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(Self.legacyPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: old)
            await sync()
        }
    }

    func sync() async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        guard let token = await uploader.ensureToken() else { return }
        var request = URLRequest(url: Config.baseURL.appendingPathComponent("api/device/reminders"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let items = try? JSONDecoder().decode(Response.self, from: data).reminders
        else { return }

        let now = Date().timeIntervalSince1970 * 1000
        let listed = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // A snooze from this Mac wins until the server shows it; done elsewhere, it's dropped.
        snoozed = snoozed.filter { id, local in
            guard let server = listed[id] else { return false }
            return server.remindAt < local.remindAt - 5_000
        }
        for item in items where snoozed[item.id] == nil && item.remindAt <= now && !isHandled(item) {
            // Came due while the Mac was asleep or the app was closed.
            ring(item, missed: now - item.remindAt > 2 * 60_000)
        }
        upcoming = items.filter { snoozed[$0.id] == nil && $0.remindAt > now } + snoozed.values.filter { $0.remindAt > now }
        scheduleNext()
    }

    // MARK: - Ringing

    private func scheduleNext() {
        nextTimer?.invalidate()
        guard let next = upcoming.min(by: { $0.remindAt < $1.remindAt }) else { return }
        let delay = max(0, next.remindAt / 1000 - Date().timeIntervalSince1970)
        nextTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.fireDue() }
        }
        // Timers pause while the Mac sleeps; the wake-up sync catches anything that came due.
        nextTimer?.tolerance = 1
    }

    private func fireDue() {
        let now = Date().timeIntervalSince1970 * 1000 + 500
        for item in upcoming where item.remindAt <= now && !isHandled(item) {
            ring(item, missed: false)
        }
        upcoming.removeAll { $0.remindAt <= now }
        scheduleNext()
    }

    private func ring(_ item: Item, missed: Bool) {
        markHandled(item)
        alarms.ring(.init(
            id: item.id,
            text: item.text,
            at: Date(timeIntervalSince1970: item.remindAt / 1000),
            recordingId: item.recordingId,
            missed: missed
        ))
        // Also leave it in Notification Center, so it's there if you were away from the Mac.
        let content = UNMutableNotificationContent()
        content.title = missed ? "Missed reminder" : "Reminder"
        content.body = item.text
        content.userInfo = ["path": item.recordingId.map { "/r/\($0)" } ?? "/"]
        Task {
            if await center.notificationSettings().authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .sound])
            }
            try? await center.add(UNNotificationRequest(identifier: "rang-\(item.id)-\(Int(item.remindAt))", content: content, trigger: nil))
        }
    }

    private func snooze(_ alert: AlarmPanel.Alert) {
        // Rings again here even if the server can't be reached right now.
        let at = (Date().timeIntervalSince1970 + Double(Self.snoozeMinutes * 60)) * 1000
        let item = Item(id: alert.id, text: alert.text, remindAt: at, recordingId: alert.recordingId)
        snoozed[alert.id] = item
        upcoming.removeAll { $0.id == alert.id }
        upcoming.append(item)
        scheduleNext()
        send(alert.id, action: "snooze")
    }

    /// Tells the server what was pressed. Best effort: the next sync reflects whatever landed.
    private func send(_ id: String, action: String) {
        Task {
            guard let token = await uploader.ensureToken(),
                  id.range(of: "^[0-9a-f-]{36}$", options: .regularExpression) != nil else { return }
            var request = URLRequest(url: Config.baseURL.appendingPathComponent("api/device/reminders/\(id)"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["action": action, "minutes": Self.snoozeMinutes])
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    // MARK: - Bookkeeping

    private func key(_ item: Item) -> String { "\(item.id)@\(Int(item.remindAt))" }

    private func isHandled(_ item: Item) -> Bool {
        (UserDefaults.standard.stringArray(forKey: Self.handledKey) ?? []).contains(key(item))
    }

    private func markHandled(_ item: Item) {
        var handled = UserDefaults.standard.stringArray(forKey: Self.handledKey) ?? []
        handled.append(key(item))
        UserDefaults.standard.set(Array(handled.suffix(500)), forKey: Self.handledKey)
    }

    // MARK: - Notification Center

    // Show the Notification Center copy even while Voice Memo is the frontmost app.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let path = response.notification.request.content.userInfo["path"] as? String ?? "/"
        await MainActor.run {
            NotificationCenter.default.post(name: .openMainWindow, object: nil)
            NSApp.activate(ignoringOtherApps: true)
            openPath?(path)
        }
    }
}
