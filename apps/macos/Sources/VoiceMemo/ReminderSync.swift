import AppKit
import UserNotifications

extension Notification.Name {
    /// Ask the app to show its main window (handled by a view that can call openWindow).
    static let openMainWindow = Notification.Name("VoiceMemoOpenMainWindow")
}

/// Shows reminders as Mac notifications. The list comes from the server with the device upload token
/// every 5 minutes, on wake, and whenever the page changes a reminder; the notifications themselves are
/// scheduled on this Mac, so they fire on time even offline.
@MainActor
final class ReminderSync: NSObject, UNUserNotificationCenterDelegate {
    private struct Item: Decodable {
        let id: String
        let text: String
        let remindAt: Double
        let recordingId: String?
    }

    private struct Response: Decodable {
        let reminders: [Item]
    }

    private static let prefix = "reminder-"
    /// Reminders already scheduled or shown, so a missed one is shown once and never twice.
    private static let handledKey = "handledReminders"

    private let uploader: Uploader
    private let center = UNUserNotificationCenter.current()
    private var timer: Timer?
    private var syncing = false
    /// Opens a path such as /r/<memo id> in the window.
    var openPath: ((String) -> Void)?

    init(uploader: Uploader) {
        self.uploader = uploader
        super.init()
        center.delegate = self
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.sync() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.sync() }
        }
        Task { await sync() }
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

        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        }
        guard await center.notificationSettings().authorizationStatus == .authorized else { return }

        let wanted = Set(items.map { Self.prefix + $0.id })
        let stale = await center.pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix(Self.prefix) && !wanted.contains($0) }
        center.removePendingNotificationRequests(withIdentifiers: stale)

        var handled = Set(UserDefaults.standard.stringArray(forKey: Self.handledKey) ?? [])
        let now = Date()
        for item in items {
            let date = Date(timeIntervalSince1970: item.remindAt / 1000)
            let trigger: UNNotificationTrigger?
            if date > now {
                let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
                trigger = UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
            } else if !handled.contains(item.id) {
                trigger = nil // missed while asleep or offline: show now
            } else {
                continue
            }
            let content = UNMutableNotificationContent()
            content.title = "Reminder"
            content.body = item.text
            content.sound = .default
            content.userInfo = ["path": item.recordingId.map { "/r/\($0)" } ?? "/"]
            try? await center.add(UNNotificationRequest(identifier: Self.prefix + item.id, content: content, trigger: trigger))
            handled.insert(item.id)
        }
        UserDefaults.standard.set(Array(handled.suffix(500)), forKey: Self.handledKey)
    }

    // Show reminders even while Voice Memo is the frontmost app.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
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
