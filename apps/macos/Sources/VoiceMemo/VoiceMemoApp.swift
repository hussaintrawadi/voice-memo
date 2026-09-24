import Carbon
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    let uploader: Uploader
    let recorder: Recorder
    let web: WebModel
    let reminders: ReminderSync
    private let bridge: WebBridge
    private var hotKey: HotKey?

    init() {
        let uploader = Uploader()
        self.uploader = uploader
        let recorder = Recorder(onPartSaved: { uploader.kick() })
        self.recorder = recorder
        let reminders = ReminderSync(uploader: uploader)
        self.reminders = reminders
        bridge = WebBridge(recorder: recorder, uploader: uploader, reminders: reminders)
        web = WebModel(bridge: bridge)
        reminders.openPath = { [weak web] path in web?.open(path: path) }
        // ⌃⌥⌘R toggles recording from anywhere.
        hotKey = HotKey(keyCode: UInt32(kVK_ANSI_R), modifiers: UInt32(cmdKey | optionKey | controlKey)) { [weak self] in
            Task { @MainActor in self?.recorder.toggle() }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Closing the window keeps the app (and the menu-bar recorder and uploads) running.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct VoiceMemoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("Voice Memo", id: "main") {
            MainWindow(web: model.web, uploader: model.uploader)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                    // Signing in in the window may have unlocked uploads.
                    model.uploader.kick()
                }
        }
        .defaultSize(width: 480, height: 820)

        MenuBarExtra {
            MenuBarPanel(recorder: model.recorder, uploader: model.uploader)
        } label: {
            MenuBarIcon(recorder: model.recorder)
        }
        .menuBarExtraStyle(.window)
    }
}

struct MenuBarIcon: View {
    @ObservedObject var recorder: Recorder
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Image(systemName: recorder.state == .idle ? "mic" : "record.circle.fill")
            .accessibilityLabel(recorder.state == .idle ? "Voice Memo" : "Voice Memo, recording")
            // The menu-bar icon is always alive, so it opens the window when a reminder is clicked.
            .onReceive(NotificationCenter.default.publisher(for: .openMainWindow)) { _ in openWindow(id: "main") }
    }
}
