import AVFoundation
import Combine
import WebKit

/// Lets the web app in the window use the native recorder and upload queue, so the big record
/// button, the menu bar and ⌃⌥⌘R all control one recording, and memos recorded in the window
/// go through the same offline queue.
///
/// JavaScript side: `window.webkit.messageHandlers.voiceMemoMac.postMessage({ method, args })`
/// returns a promise (see src/lib/native.ts). Queue changes arrive as a `voicememo:queue` event.
@MainActor
final class WebBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "voiceMemoMac"

    private let recorder: Recorder
    private let uploader: Uploader
    private let reminders: ReminderSync
    weak var webView: WKWebView?
    private var subscriptions = Set<AnyCancellable>()

    init(recorder: Recorder, uploader: Uploader, reminders: ReminderSync) {
        self.recorder = recorder
        self.uploader = uploader
        self.reminders = reminders
        super.init()
        uploader.$pending
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] _ in self?.emit("voicememo:queue") }
            .store(in: &subscriptions)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        // Only our own site may drive the recorder.
        guard message.frameInfo.securityOrigin.host == Config.baseURL.host,
              let body = message.body as? [String: Any],
              let method = body["method"] as? String
        else {
            replyHandler(nil, "Not allowed")
            return
        }
        let args = body["args"] as? [String: Any] ?? [:]

        switch method {
        case "status":
            replyHandler(status(), nil)
        case "start":
            Task {
                // Ask for the microphone first, so a refusal comes back to the page as an error.
                if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                    _ = await AVCaptureDevice.requestAccess(for: .audio)
                }
                recorder.start()
                replyHandler(nil, recorder.state == .idle ? recorder.lastError ?? "Couldn't start recording" : nil)
            }
        case "pause":
            recorder.pause()
            replyHandler(nil, nil)
        case "resume":
            recorder.resume()
            replyHandler(nil, nil)
        case "stop":
            recorder.stop()
            replyHandler(["saved": true], nil)
        case "cancel":
            recorder.cancel()
            replyHandler(nil, nil)
        case "listPending":
            uploader.refresh()
            replyHandler(["items": uploader.pending.map(pendingJSON)], nil)
        case "retryUploads":
            uploader.retryBlocked()
            replyHandler(nil, nil)
        case "deletePending":
            if let id = args["id"] as? String { uploader.delete(id) }
            replyHandler(nil, nil)
        case "signedIn":
            uploader.kick()
            Task { await reminders.sync() }
            replyHandler(nil, nil)
        case "syncReminders":
            Task { await reminders.sync() }
            replyHandler(nil, nil)
        case "signOut":
            Task {
                await uploader.signOut()
                replyHandler(nil, nil)
            }
        default:
            replyHandler(nil, "Unknown method \(method)")
        }
    }

    private func status() -> [String: Any] {
        let state: String = switch recorder.state {
        case .idle: "idle"
        case .recording: "recording"
        case .paused: "paused"
        }
        return ["state": state, "elapsedSec": recorder.elapsed, "level": recorder.level]
    }

    private func pendingJSON(_ item: PendingItem) -> [String: Any] {
        [
            "id": item.id,
            "recordedAt": item.recordedAt,
            "durationSec": item.durationSec,
            "bytes": item.bytes,
            "attempts": item.attempts,
            "lastError": item.lastError ?? NSNull(),
            "blocked": item.blocked,
        ]
    }

    private func emit(_ event: String) {
        webView?.evaluateJavaScript("window.dispatchEvent(new Event('\(event)'))", completionHandler: nil)
    }
}
