import AVFoundation
import Foundation

/// Native recorder for the menu bar and global shortcut. Records AAC (m4a) at 32 kbps,
/// cuts long sessions into 30-minute parts, and hands every finished part to the upload queue.
@MainActor
final class Recorder: ObservableObject {
    enum State { case idle, recording, paused }

    // Only state changes are published. The timer and level change ten times a second; publishing
    // them made SwiftUI redraw the menu-bar icon constantly. Views that show them poll while visible.
    @Published private(set) var state: State = .idle
    @Published var lastError: String?
    /// Current input level, 0–1.
    private(set) var level: Double = 0
    /// Seconds recorded in this session, across all parts.
    var elapsed: TimeInterval { finishedPartsTime + (recorder?.currentTime ?? 0) }

    private let onPartSaved: () -> Void
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var sessionId = ""
    private var partIndex = 0
    private var partId = ""
    private var partStartedAt = Date()
    private var partPeak: Double = 0
    /// Time recorded in finished parts of this session.
    private var finishedPartsTime: TimeInterval = 0

    private static let maxPartSeconds: TimeInterval = 30 * 60

    init(onPartSaved: @escaping () -> Void) {
        self.onPartSaved = onPartSaved
    }

    func toggle() {
        switch state {
        case .idle: start()
        case .recording, .paused: stop()
        }
    }

    func start() {
        guard state == .idle else { return }
        lastError = nil
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            beginSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                Task { @MainActor in
                    if granted { self.beginSession() } else { self.lastError = "Microphone access was denied." }
                }
            }
        default:
            lastError = "Allow microphone access for Voice Memo in System Settings → Privacy & Security → Microphone."
        }
    }

    func pause() {
        guard state == .recording, let recorder else { return }
        recorder.pause()
        state = .paused
        level = 0
    }

    func resume() {
        guard state == .paused, let recorder else { return }
        recorder.record()
        state = .recording
    }

    func stop() {
        guard state != .idle else { return }
        finishPart()
        endSession()
    }

    func cancel() {
        guard state != .idle else { return }
        recorder?.stop()
        recorder?.deleteRecording()
        recorder = nil
        endSession()
    }

    // MARK: - Internals

    private func beginSession() {
        sessionId = UUID().uuidString.lowercased()
        partIndex = 0
        finishedPartsTime = 0
        do {
            try beginPart()
        } catch {
            lastError = "Couldn't start recording: \(error.localizedDescription)"
            return
        }
        state = .recording
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func beginPart() throws {
        partId = UUID().uuidString.lowercased()
        partStartedAt = Date()
        partPeak = 0
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
        ]
        let r = try AVAudioRecorder(url: PendingStore.audioURL(partId), settings: settings)
        r.isMeteringEnabled = true
        guard r.record() else { throw NSError(domain: "VoiceMemo", code: 1, userInfo: [NSLocalizedDescriptionKey: "The microphone is busy."]) }
        recorder = r
    }

    private func tick() {
        guard let recorder else { return }
        if state == .recording {
            recorder.updateMeters()
            let linear = pow(10, Double(recorder.peakPower(forChannel: 0)) / 20)
            partPeak = max(partPeak, linear)
            level = min(1, linear * 1.5)
            if recorder.currentTime >= Self.maxPartSeconds { rollover() }
        }
    }

    private func rollover() {
        finishPart()
        partIndex += 1
        do {
            try beginPart()
        } catch {
            lastError = "Couldn't continue recording: \(error.localizedDescription)"
            endSession()
        }
    }

    /// Stops the current part and puts it in the upload queue.
    private func finishPart() {
        guard let recorder else { return }
        let duration = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        finishedPartsTime += duration
        let url = PendingStore.audioURL(partId)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        guard bytes > 0, duration > 0.3 else {
            PendingStore.delete(partId)
            return
        }
        let item = PendingItem(
            id: partId,
            recordedAt: Int64(partStartedAt.timeIntervalSince1970 * 1000),
            durationSec: (duration * 10).rounded() / 10,
            bytes: bytes,
            partOf: sessionId,
            partIndex: partIndex,
            peak: (min(1, partPeak) * 10_000).rounded() / 10_000
        )
        do {
            try PendingStore.save(item)
            onPartSaved()
        } catch {
            lastError = "Couldn't save the recording: \(error.localizedDescription)"
        }
    }

    private func endSession() {
        timer?.invalidate()
        timer = nil
        state = .idle
        finishedPartsTime = 0
        level = 0
    }
}
