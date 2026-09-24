import ServiceManagement
import SwiftUI

/// The menu-bar panel: one-tap recording, upload status, and quick links.
struct MenuBarPanel: View {
    @ObservedObject var recorder: Recorder
    @ObservedObject var uploader: Uploader
    @Environment(\.openWindow) private var openWindow
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        VStack(spacing: 14) {
            recordingControls
            if let error = recorder.lastError {
                Text(error).font(.caption).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Divider()
            uploadStatus
            Divider()
            HStack {
                Button("Open Voice Memo") { showMainWindow() }
                Spacer()
                Toggle("Open at login", isOn: $launchAtLogin)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                    .onChange(of: launchAtLogin) { _, enabled in setLaunchAtLogin(enabled) }
            }
            HStack {
                Text("Record from anywhere: ⌃⌥⌘R").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }.font(.caption)
            }
        }
        .padding(16)
        .frame(width: 300)
    }

    @ViewBuilder private var recordingControls: some View {
        if recorder.state == .idle {
            Button {
                recorder.start()
            } label: {
                Label("Record a memo", systemImage: "mic.fill")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(red: 0.89, green: 0.34, blue: 0.18))
            .controlSize(.large)
        } else {
            VStack(spacing: 10) {
                // Redraws four times a second, and only while this panel is open.
                TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                    VStack(spacing: 10) {
                        HStack(spacing: 8) {
                            Circle()
                                .fill(Color(red: 0.89, green: 0.34, blue: 0.18))
                                .frame(width: 8, height: 8)
                                .opacity(recorder.state == .recording ? 1 : 0.35)
                            Text(recorder.state == .recording ? "Recording" : "Paused").font(.subheadline.weight(.medium))
                            Spacer()
                            Text(format(recorder.elapsed)).font(.system(.title2, design: .serif).monospacedDigit())
                        }
                        ProgressView(value: recorder.level).tint(Color(red: 0.89, green: 0.34, blue: 0.18))
                    }
                }
                HStack {
                    Button("Discard", role: .destructive) { recorder.cancel() }
                    Spacer()
                    Button(recorder.state == .recording ? "Pause" : "Resume") {
                        recorder.state == .recording ? recorder.pause() : recorder.resume()
                    }
                    Button("Stop & save") { recorder.stop() }.buttonStyle(.borderedProminent)
                }
            }
        }
    }

    @ViewBuilder private var uploadStatus: some View {
        let count = uploader.pending.count
        HStack(alignment: .top) {
            Image(systemName: count == 0 ? "checkmark.icloud" : uploader.online ? "icloud.and.arrow.up" : "icloud.slash")
                .foregroundStyle(count == 0 ? .green : .orange)
            VStack(alignment: .leading, spacing: 2) {
                if count == 0 {
                    Text("All memos uploaded").font(.caption)
                } else if uploader.needsSignIn {
                    Text("\(count) waiting. Sign in in the Voice Memo window to upload.").font(.caption)
                } else if !uploader.online {
                    Text("\(count) saved on this Mac. They'll upload when you're online.").font(.caption)
                } else {
                    Text(uploader.uploading ? "Uploading \(count)…" : "\(count) waiting to upload").font(.caption)
                    if let error = uploader.pending.first(where: { $0.lastError != nil })?.lastError {
                        Text(error).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
            Spacer()
            if count > 0 && uploader.online {
                Button("Retry") { uploader.retryBlocked() }.font(.caption)
            }
        }
    }

    private func showMainWindow() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            recorder.lastError = "Couldn't change login item: \(error.localizedDescription)"
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }

    private func format(_ t: TimeInterval) -> String {
        let s = Int(t)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}
