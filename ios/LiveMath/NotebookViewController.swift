import UIKit
import WebKit

/// The whole app: the notebook page in a WKWebView, plus the things only a native iPad app can do —
/// Apple Pencil double-tap and squeeze switch pen ⇄ eraser (as set in Settings → Apple Pencil),
/// Scribble is kept from turning ink into typed text, and exports go to the share sheet.
final class NotebookViewController: UIViewController {
    private static let paper = UIColor(red: 0xf3 / 255, green: 0xf5 / 255, blue: 0xf4 / 255, alpha: 1)
    private var webView: WKWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        if let web = Bundle.main.url(forResource: "web", withExtension: nil) {
            config.setURLSchemeHandler(BundleSchemeHandler(root: web), forURLScheme: BundleSchemeHandler.scheme)
        }
        config.userContentController.add(WeakScriptHandler(self), name: "lmnSave")
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = Self.paper
        webView.allowsLinkPreview = false
        // the page pans and zooms itself; the web view must not scroll, bounce or pinch
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.backgroundColor = Self.paper
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            #if DEBUG
            webView.isInspectable = true
            #endif
        }
        self.webView = webView

        let root = UIView()
        root.backgroundColor = Self.paper
        root.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: root.safeAreaLayoutGuide.bottomAnchor)
        ])

        let pencil = UIPencilInteraction()
        pencil.delegate = self
        root.addInteraction(pencil)
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: "\(BundleSchemeHandler.scheme)://app/index.html")!))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        keepScribbleOff()
    }

    // writing near the bottom edge shouldn't pull up the Home screen on the first swipe
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }

    private func toggleEraser() {
        webView.evaluateJavaScript("window.LiveMath && window.LiveMath.pencilDoubleTap && window.LiveMath.pencilDoubleTap()")
    }

    /// Scribble would turn handwriting into typed text; on a math page the ink is the point.
    private func keepScribbleOff() {
        for sub in webView.scrollView.subviews where String(describing: type(of: sub)).hasPrefix("WKContentView") {
            if !sub.interactions.contains(where: { $0 is UIScribbleInteraction }) {
                sub.addInteraction(UIScribbleInteraction(delegate: self))
            }
        }
    }

    private func share(fileNamed name: String, data: Data) {
        let safeName = name.replacingOccurrences(of: "/", with: "-")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent(safeName)
            try data.write(to: file)
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.maxX - 64, y: view.safeAreaInsets.top + 44, width: 1, height: 1)
                popover.permittedArrowDirections = [.up]
            }
            present(sheet, animated: true)
        } catch {
            webView.evaluateJavaScript("typeof toast === 'function' && toast('Couldn’t save the file')")
        }
    }
}

// MARK: - Apple Pencil

extension NotebookViewController: UIPencilInteractionDelegate {
    // iPadOS 12.1 – 17.4
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        if #available(iOS 17.5, *) { return }
        guard UIPencilInteraction.preferredTapAction != .ignore else { return }
        toggleEraser()
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        guard UIPencilInteraction.preferredTapAction != .ignore else { return }
        toggleEraser()
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended, UIPencilInteraction.preferredSqueezeAction != .ignore else { return }
        toggleEraser()
    }
}

extension NotebookViewController: UIScribbleInteractionDelegate {
    func scribbleInteraction(_ interaction: UIScribbleInteraction, shouldBeginAt location: CGPoint) -> Bool { false }
}

// MARK: - Files from the page (PDF, PNG, notebook file) → share sheet

extension NotebookViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "lmnSave",
              let body = message.body as? [String: Any],
              let name = body["filename"] as? String,
              let base64 = body["data"] as? String,
              let data = Data(base64Encoded: base64) else { return }
        share(fileNamed: name, data: data)
    }
}

// MARK: - Navigation

extension NotebookViewController: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? ""), action.targetFrame?.isMainFrame ?? true {
            UIApplication.shared.open(url)   // links open in Safari, never inside the notebook
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    // if iPadOS stops the page to free memory, bring it straight back (notebooks are saved as you write)
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}

/// WKUserContentController keeps its handlers alive; this keeps it from keeping the view controller alive too.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
