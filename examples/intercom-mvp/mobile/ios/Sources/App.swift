import UIKit
import WebKit
import Security

enum Vault {
    static func get(_ name: String) -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "intercom", kSecAttrAccount as String: name, kSecReturnData as String: true]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func set(_ name: String, _ value: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "intercom", kSecAttrAccount as String: name]
        SecItemDelete(query as CFDictionary)
        var item = query; item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw URLError(.cannotCreateFile) }
    }
}
enum API {
    static var base: String { UserDefaults.standard.string(forKey: "api") ?? "" }
    static var deviceId: String { UserDefaults.standard.string(forKey: "deviceId") ?? "" }
    static func request(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url); request.timeoutInterval = 6
        request.setValue("Bearer " + Vault.get("token"), forHTTPHeaderField: "Authorization")
        if let body = body { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw URLError(.badServerResponse) }
        return value
    }
}
@main class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = MainController(); window.makeKeyAndVisible(); self.window = window
        _ = Calls.shared
        return true
    }
}
class MainController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    var web: WKWebView!
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        Calls.shared.screen = self
        if API.base.isEmpty { DispatchQueue.main.async { self.setup() } } else { load() }
    }
    func setup() {
        let alert = UIAlertController(title: "Настройка", message: "HTTPS API и SIP account", preferredStyle: .alert)
        alert.addTextField { $0.placeholder = "https://intercom.example.com"; $0.keyboardType = .URL }
        alert.addTextField { $0.placeholder = "<sip:100@pbx>;auth_pass=…;regint=300"; $0.isSecureTextEntry = true }
        alert.addAction(UIAlertAction(title: "Сохранить", style: .default) { _ in
            let text = alert.textFields![0].text ?? "", account = alert.textFields![1].text ?? ""
            guard let url = URLComponents(string: text), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { self.setup(); return }
            do { try Vault.set("account", account); UserDefaults.standard.set(text.hasSuffix("/") ? String(text.dropLast()) : text, forKey: "api"); self.load() }
            catch { self.setup() }
        }); present(alert, animated: true)
    }
    func load() {
        let config = WKWebViewConfiguration(); config.userContentController.add(self, name: "intercom")
        config.allowsInlineMediaPlayback = true; config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: config); web.navigationDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(web)
        NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor), web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)])
        web.load(URLRequest(url: URL(string: API.base + "/")!)); SipEngine.shared.start()
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.absoluteString == API.base + "/" ? .allow : .cancel)
    }
    func result(_ id: String, _ error: String? = nil) {
        guard let web = web, let data = try? JSONSerialization.data(withJSONObject: [id, error as Any? ?? NSNull(), NSNull()]), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.intercomResult?.(...\(json))", completionHandler: nil)
    }
    func event(_ type: String, _ sip: String) {
        guard let web = web, let data = try? JSONSerialization.data(withJSONObject: ["type": type, "sipCallId": sip]), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.intercomEvent?.(\(json))", completionHandler: nil)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.absoluteString == API.base + "/", let data = message.body as? [String: Any], let id = data["id"] as? String, let action = data["action"] as? String else { return }
        if action == "configureApi", let token = data["token"] as? String, let device = data["deviceId"] as? String {
            do { try Vault.set("token", token); UserDefaults.standard.set(device, forKey: "deviceId") } catch { result(id, "Не удалось сохранить токен"); return }
            Task {
                do { let boot = try await API.request("/api/bootstrap"); UserDefaults.standard.set(boot["portalUrl"], forKey: "portal"); await Calls.shared.registerToken(); await MainActor.run { self.result(id) } }
                catch { await MainActor.run { self.result(id, "Не удалось подключить API") } }
            }
        } else if action == "portal", let target = data["url"] as? String, target == UserDefaults.standard.string(forKey: "portal"), let url = URL(string: target), url.scheme == "https" {
            let portal = PortalController(); portal.target = url; present(UINavigationController(rootViewController: portal), animated: true); result(id)
        } else if let sip = data["sipCallId"] as? String {
            if action == "answer", let callId = data["callId"] as? String { Calls.shared.foreground(callId, sip) }
            SipEngine.shared.command(action == "answer" ? 1 : action == "end" ? 2 : 3, sip, data["digits"] as? String ?? "", data["requestId"] as? String ?? id) { error in self.result(id, error) }
        } else { result(id, "Неизвестное действие") }
    }
}
class PortalController: UIViewController, WKNavigationDelegate {
    var target: URL!
    override func viewDidLoad() {
        super.viewDidLoad(); title = "Личный кабинет"; navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Закрыть", style: .done, target: self, action: #selector(close))
        let web = WKWebView(frame: view.bounds); web.autoresizingMask = [.flexibleWidth, .flexibleHeight]; web.navigationDelegate = self; view.addSubview(web); web.load(URLRequest(url: target))
    }
    @objc func close() { dismiss(animated: true) }
    func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { decisionHandler(action.request.url?.scheme == "https" && action.request.url?.host == target.host ? .allow : .cancel) }
}
