import Foundation
import PushKit
import CallKit
import AVFoundation

class Calls: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
    static let shared = Calls()
    weak var screen: MainController?
    private let registry = PKPushRegistry(queue: .main)
    private let provider: CXProvider
    private var current: (id: UUID, sip: String)?
    private var polling: Task<Void, Never>?
    override init() {
        let config = CXProviderConfiguration(); config.supportsVideo = false; config.maximumCallsPerCallGroup = 1; config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config); super.init(); provider.setDelegate(self, queue: .main)
        registry.delegate = self; registry.desiredPushTypes = [.voIP]
    }
    func registerToken() async {
        let token = UserDefaults.standard.string(forKey: "pushToken") ?? ""
        guard !token.isEmpty && !Vault.get("token").isEmpty else { return }
        do { _ = try await API.request("/api/devices", ["deviceId": API.deviceId, "platform": "ios", "token": token]) }
        catch { await MainActor.run { self.screen?.event("push_registration_failed", "") } }
    }
    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        UserDefaults.standard.set(credentials.token.map { String(format: "%02x", $0) }.joined(), forKey: "pushToken")
        Task { await registerToken() }
    }
    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) { UserDefaults.standard.removeObject(forKey: "pushToken") }
    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let data = payload.dictionaryPayload
        let id = (data["callId"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()
        let sip = data["sipCallId"] as? String ?? ""
        let update = CXCallUpdate(); update.remoteHandle = CXHandle(type: .generic, value: data["name"] as? String ?? "Домофон"); update.hasVideo = false
        // CallKit is reported before any network wait, including stale/invalid VoIP pushes.
        provider.reportNewIncomingCall(with: id, update: update) { error in
            completion()
            DispatchQueue.main.async {
                guard error == nil else { return }
                guard self.current == nil, !sip.isEmpty, let expires = data["expiresAt"] as? NSNumber, expires.doubleValue > Date().timeIntervalSince1970 * 1000 else { self.provider.reportCall(with: id, endedAt: Date(), reason: .failed); return }
                self.current = (id, sip); SipEngine.shared.start(); self.poll()
            }
        }
    }
    func foreground(_ id: String, _ sip: String) { if let uuid = UUID(uuidString: id) { current = (uuid, sip); poll() } }
    private func poll() {
        polling?.cancel()
        polling = Task {
            while !Task.isCancelled {
                guard let current = await MainActor.run(body: { self.current }) else { return }
                do {
                    let result = try await API.request("/api/calls/" + current.id.uuidString.lowercased())
                    guard let call = result["call"] as? [String: Any], call["sipCallId"] as? String == current.sip,
                          !["ended", "expired"].contains(call["state"] as? String ?? ""),
                          (call["expiresAt"] as? Double ?? 0) > Date().timeIntervalSince1970 * 1000,
                          call["deviceId"] == nil || call["deviceId"] as? String == API.deviceId else { await MainActor.run { self.end() }; return }
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                } catch { if !Task.isCancelled { await MainActor.run { self.end() } }; return }
            }
        }
    }
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let current = current, current.id == action.callUUID else { action.fail(); return }
        Task {
            do {
                guard await AVAudioSession.sharedInstance().requestPermission() else { throw URLError(.userAuthenticationRequired) }
                _ = try await API.request("/api/calls/" + current.id.uuidString.lowercased() + "/answer", ["deviceId": API.deviceId])
                await MainActor.run {
                    do { try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth]) }
                    catch { action.fail(); self.end(); return }
                    SipEngine.shared.command(1, current.sip) { error in if error == nil { action.fulfill() } else { action.fail(); self.end() } }
                }
            } catch { await MainActor.run { action.fail(); self.end() } }
        }
    }
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) { end(); action.fulfill() }
    func providerDidReset(_ provider: CXProvider) { end() }
    func provider(_ provider: CXProvider, didActivate session: AVAudioSession) { }
    func provider(_ provider: CXProvider, didDeactivate session: AVAudioSession) { }
    func sipEvent(_ type: String, _ sip: String) {
        guard let current = current, current.sip == sip else { return }
        if type == "closed" { end() }
        if type == "established" { Task { do { _ = try await API.request("/api/calls/" + current.id.uuidString.lowercased() + "/active", ["deviceId": API.deviceId]) } catch { await MainActor.run { self.end() } } } }
    }
    private func end() {
        guard let current = current else { return }; self.current = nil; polling?.cancel()
        SipEngine.shared.command(2, current.sip) { _ in }
        provider.reportCall(with: current.id, endedAt: Date(), reason: .remoteEnded)
        Task { _ = try? await API.request("/api/calls/" + current.id.uuidString.lowercased() + "/end", ["deviceId": API.deviceId]) }
    }
}
private extension AVAudioSession {
    func requestPermission() async -> Bool { await withCheckedContinuation { continuation in requestRecordPermission { continuation.resume(returning: $0) } } }
}
