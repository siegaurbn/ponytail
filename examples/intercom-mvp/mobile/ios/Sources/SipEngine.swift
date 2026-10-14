import Foundation
private let receiveSipEvent: @convention(c) (UnsafePointer<CChar>?, UnsafePointer<CChar>?, UnsafePointer<CChar>?, Int32) -> Void = { type, sip, id, error in
    let type = type.map { String(cString: $0) } ?? "", sip = sip.map { String(cString: $0) } ?? "", id = id.map { String(cString: $0) } ?? ""
    DispatchQueue.main.async { SipEngine.shared.event(type, sip, id, error) }
}
class SipEngine {
    static let shared = SipEngine()
    private var starting = false
    private var pending: [String: (String?) -> Void] = [:]
    func start() {
        guard !starting else { return }; starting = true
        DispatchQueue.global(qos: .userInitiated).async {
            defer { DispatchQueue.main.async { self.starting = false } }
            do {
                let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("sip")
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try Data("audio_player audiounit,default\naudio_source audiounit,default\nmodule g711\nmodule audiounit\nmodule auconv\nmodule auresamp\n".utf8).write(to: directory.appendingPathComponent("config"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                let account = Vault.get("account"); guard !account.isEmpty else { return }
                let error = ic_start(directory.path, account, receiveSipEvent)
                if error != 0 && error != EALREADY { DispatchQueue.main.async { Calls.shared.screen?.event("sip_error", "") } }
            } catch { DispatchQueue.main.async { Calls.shared.screen?.event("sip_error", "") } }
        }
    }
    func command(_ operation: Int32, _ sip: String, _ digits: String = "", _ id: String = UUID().uuidString, completion: @escaping (String?) -> Void) {
        pending[id] = completion
        let error = ic_command(operation, sip, digits, id)
        if error != 0 { pending.removeValue(forKey: id)?("SIP недоступен: \(error)") }
        else { DispatchQueue.main.asyncAfter(deadline: .now() + 12) { self.pending.removeValue(forKey: id)?("SIP не ответил") } }
    }
    func event(_ type: String, _ sip: String, _ id: String, _ error: Int32) {
        if type == "command" { pending.removeValue(forKey: id)?(error == 0 ? nil : "SIP ошибка: \(error)") }
        Calls.shared.sipEvent(type, sip)
        Calls.shared.screen?.event(type, sip)
    }
}
