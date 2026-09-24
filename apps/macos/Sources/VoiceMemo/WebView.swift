import AppKit
import SwiftUI
import WebKit

/// The Voice Memo web app in a native window. Sign-in happens here; the menu-bar recorder
/// borrows this session once to create its own upload token.
@MainActor
final class WebModel: NSObject, ObservableObject, WKUIDelegate, WKNavigationDelegate {
    let webView: WKWebView
    @Published private(set) var loadFailed = false

    init(bridge: WebBridge) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: WebBridge.name)
        // Lets the web app's "signed-in devices" list show this as the Mac app.
        config.applicationNameForUserAgent = "Version/19.0 Safari/605.1.15 VoiceMemo Mac app"
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        bridge.webView = webView
        // Test servers only: `-testSession <token>` signs the window in to a local test account.
        if Config.isTestServer, let session = UserDefaults.standard.string(forKey: "testSession"), let host = Config.baseURL.host,
           let cookie = HTTPCookie(properties: [.name: "vm_session", .value: session, .domain: host, .path: "/"]) {
            config.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in self?.reload() }
        } else {
            reload()
        }
    }

    /// Shows an in-app path (e.g. a reminder's memo) without reloading the page.
    func open(path: String) {
        guard path.range(of: "^/(r/[0-9a-f-]{36})?$", options: .regularExpression) != nil else { return }
        webView.evaluateJavaScript("history.pushState({}, '', '\(path)'); dispatchEvent(new PopStateEvent('popstate'));", completionHandler: nil)
    }

    func reload() {
        loadFailed = false
        webView.load(URLRequest(url: Config.baseURL, cachePolicy: .useProtocolCachePolicy))
    }

    /// The page records through WebBridge; this only covers an older cached page that still uses
    /// the browser recorder. Allowed for our site only.
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(origin.host == Config.baseURL.host && type == .microphone ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadFailed = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadFailed = true
    }

    /// Links to other sites open in the default browser.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url, url.host != Config.baseURL.host, navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    // The web app uses window.confirm / alert (e.g. "Delete this memo?"); WKWebView needs these to show them.

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }
}

struct WebView: NSViewRepresentable {
    let model: WebModel
    func makeNSView(context: Context) -> WKWebView { model.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

struct MainWindow: View {
    @ObservedObject var web: WebModel
    @ObservedObject var uploader: Uploader

    var body: some View {
        ZStack {
            WebView(model: web)
            if web.loadFailed {
                VStack(spacing: 12) {
                    Image(systemName: "wifi.slash").font(.system(size: 36)).foregroundStyle(.secondary)
                    Text("You're offline").font(.title2.weight(.semibold))
                    Text("You can still record from the menu bar (⌃⌥⌘R). Memos upload automatically when you're back online.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 360)
                    Button("Try again") { web.reload() }.keyboardShortcut(.defaultAction)
                }
                .padding(40)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
            }
        }
        .frame(minWidth: 420, minHeight: 560)
        .onChange(of: uploader.online) { _, isOnline in
            if isOnline && web.loadFailed { web.reload() }
        }
    }
}
