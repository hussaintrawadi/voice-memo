import AppKit
import SwiftUI

/// A reminder that needs answering: shown above every window and on every desktop,
/// with a repeating sound, until you press Done or Snooze.
@MainActor
final class AlarmPanel {
    struct Alert: Equatable {
        let id: String
        let text: String
        let at: Date
        let recordingId: String?
        let missed: Bool
    }

    /// Ring for at most this long; the panel stays until answered.
    private static let ringSeconds: TimeInterval = 60

    private var panel: NSPanel?
    private var sound: NSSound?
    private var stopTimer: Timer?
    private var queue: [Alert] = []

    var onDone: ((Alert) -> Void)?
    var onSnooze: ((Alert) -> Void)?
    var onOpen: ((Alert) -> Void)?

    /// Rings now, or after the reminder already on screen is answered.
    func ring(_ alert: Alert) {
        guard !queue.contains(where: { $0.id == alert.id }) else { return }
        queue.append(alert)
        if queue.count == 1 { present(alert) }
    }

    private func present(_ alert: Alert) {
        let view = AlarmView(
            alert: alert,
            done: { [weak self] in self?.answer { self?.onDone?(alert) } },
            snooze: { [weak self] in self?.answer { self?.onSnooze?(alert) } },
            open: { [weak self] in self?.answer { self?.onOpen?(alert) } }
        )
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isMovableByWindowBackground = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: view)
        panel.center()
        panel.orderFrontRegardless()
        self.panel = panel

        if !alert.missed { startSound() }
    }

    private func answer(_ action: () -> Void) {
        stopSound()
        panel?.close()
        panel = nil
        action()
        if !queue.isEmpty { queue.removeFirst() }
        if let next = queue.first { present(next) }
    }

    private func startSound() {
        stopSound()
        let sound = NSSound(named: NSSound.Name("Glass")) ?? NSSound(named: NSSound.Name("Ping"))
        sound?.loops = true
        sound?.play()
        self.sound = sound
        stopTimer = Timer.scheduledTimer(withTimeInterval: Self.ringSeconds, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.stopSound() }
        }
    }

    private func stopSound() {
        stopTimer?.invalidate()
        stopTimer = nil
        sound?.stop()
        sound = nil
    }
}

private struct AlarmView: View {
    let alert: AlarmPanel.Alert
    let done: () -> Void
    let snooze: () -> Void
    let open: () -> Void

    private static let brand = Color(red: 0.12, green: 0.24, blue: 0.21)
    private static let cream = Color(red: 0.96, green: 0.96, blue: 0.94)
    private static let accent = Color(red: 0.89, green: 0.34, blue: 0.18)

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "bell.fill")
                .font(.system(size: 30))
                .foregroundStyle(Self.accent)
            Text(alert.missed ? "MISSED REMINDER" : "REMINDER")
                .font(.caption.weight(.medium))
                .tracking(2)
                .foregroundStyle(Self.cream.opacity(0.7))
            Text(alert.at, style: .time)
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Self.cream)
            Text(alert.text)
                .font(.system(.title3, design: .serif))
                .multilineTextAlignment(.center)
                .foregroundStyle(Self.cream)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                if !alert.missed {
                    Button("Snooze 10 min", action: snooze)
                        .buttonStyle(AlarmButton(fill: Self.cream.opacity(0.18), text: Self.cream))
                }
                Button("Done", action: done)
                    .buttonStyle(AlarmButton(fill: Self.accent, text: .white))
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.top, 6)
            Button("Open in Voice Memo", action: open)
                .buttonStyle(.plain)
                .font(.callout)
                .foregroundStyle(Self.cream.opacity(0.7))
        }
        .padding(28)
        .frame(width: 420)
        .background(Self.brand)
    }
}

private struct AlarmButton: ButtonStyle {
    let fill: Color
    let text: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(text)
            .frame(maxWidth: .infinity, minHeight: 40)
            .background(fill.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 10))
    }
}
