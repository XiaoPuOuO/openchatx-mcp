import AppKit
import Foundation
import Security
import WebKit

final class RuntimeSupervisor: NSObject {
    private static let defaultRuntimePort = 8001
    private static let defaultTunnelHealthPort = 8080

    struct Snapshot {
        let backend: Bool
        let tunnel: Bool
        let tunnelProfile: Bool
        let dotEnabled: Bool
        let dotTunnel: Bool
        let dotTunnelProfile: Bool
    }

    struct DesktopPreferences {
        let closeToTray: Bool
        let startMinimized: Bool
        let notificationsEnabled: Bool
        let notifyTunnelDisconnected: Bool
    }

    private var backendProcess: Process?
    private var tunnelProcess: Process?
    private var dotTunnelProcess: Process?
    private(set) var backendOwned = false
    private(set) var tunnelOwned = false
    private(set) var dotTunnelOwned = false

    let appSupport: URL
    let logsDirectory: URL
    private let profileDirectory: URL
    private let runtimeRoot: URL
    private let nodeExecutable: URL
    private let tunnelExecutable: URL
    private let fileManager = FileManager.default

    var onSnapshot: ((Snapshot) -> Void)?
    var dashboardURL: URL { URL(string: "http://127.0.0.1:\(runtimePort)/ui/")! }
    private var backendHealthURL: URL { URL(string: "http://127.0.0.1:\(runtimePort)/healthz")! }
    private var tunnelHealthURL: URL { URL(string: "http://127.0.0.1:\(tunnelHealthPort)/health?details=true")! }
    private var mcpServerURL: String { "http://127.0.0.1:\(runtimePort)/mcp" }
    private var tunnelHealthListenAddress: String { "127.0.0.1:\(tunnelHealthPort)" }
    var isDotEnabled: Bool { readConfiguredBool(section: "dot", key: "enabled", fallback: false) }
    var dotProfileName: String { readConfiguredString(section: "dot", key: "profile", fallback: "openchatx-dot") }
    private var dotRuntimePort: Int { readConfiguredPort(section: "dot", key: "port", fallback: 8002) }
    private var dotTunnelHealthPort: Int { readConfiguredPort(section: "dot", key: "health_port", fallback: 8081) }
    private var dotMcpServerURL: String { "http://127.0.0.1:\(dotRuntimePort)/mcp" }
    private var dotTunnelHealthURL: URL { URL(string: "http://127.0.0.1:\(dotTunnelHealthPort)/health?details=true")! }
    private var dotTunnelHealthListenAddress: String { "127.0.0.1:\(dotTunnelHealthPort)" }

    override init() {
        let bundleResources = Bundle.main.resourceURL!
        runtimeRoot = bundleResources.appendingPathComponent("runtime", isDirectory: true)
        nodeExecutable = runtimeRoot.appendingPathComponent("bin/node")
        tunnelExecutable = runtimeRoot.appendingPathComponent("bin/tunnel-client")

        let supportBase = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        appSupport = supportBase.appendingPathComponent("OpenChatX", isDirectory: true)
        logsDirectory = appSupport.appendingPathComponent("logs", isDirectory: true)
        profileDirectory = appSupport.appendingPathComponent(
            "tunnel-profiles",
            isDirectory: true
        )
        super.init()
    }

    func prepareState() throws {
        let configDirectory = appSupport.appendingPathComponent("config", isDirectory: true)
        let toolboxDirectory = appSupport.appendingPathComponent("toolboxes", isDirectory: true)
        try fileManager.createDirectory(at: configDirectory, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: profileDirectory, withIntermediateDirectories: true)

        let publicConfig = configDirectory.appendingPathComponent("openchatx.toml")
        try copyDefault(
            from: runtimeRoot.appendingPathComponent(".openchatx/config.toml"),
            to: publicConfig
        )
        try migrateLegacyRuntimePort(publicConfig)
        try copyDefault(
            from: runtimeRoot.appendingPathComponent("defaults/mcp-servers.json"),
            to: configDirectory.appendingPathComponent("mcp-servers.json")
        )
        try copyDefault(
            from: runtimeRoot.appendingPathComponent("defaults/subagents.json"),
            to: configDirectory.appendingPathComponent("subagents.json")
        )
        try syncDefaultToolboxes(
            from: runtimeRoot.appendingPathComponent("defaults/toolboxes", isDirectory: true),
            to: toolboxDirectory
        )
    }

    func start() {
        DispatchQueue.global(qos: .userInitiated).async {
            self.maintainRuntime()
            self.publishSnapshot()
        }
    }

    func maintainRuntime() {
        do {
            try prepareState()
            if !isHealthy(backendHealthURL), backendProcess?.isRunning != true {
                try startBackend()
                _ = waitUntilHealthy(backendHealthURL, attempts: 50)
            }
            if hasTunnelProfile(), !isTunnelHealthy(), tunnelProcess?.isRunning != true {
                try startTunnel()
            }
            if isDotEnabled,
               hasTunnelProfile(named: dotProfileName),
               !isTunnelHealthy(dotTunnelHealthURL),
               dotTunnelProcess?.isRunning != true {
                try startDotTunnel()
            }
        } catch {
            appendDesktopLog("Runtime maintenance failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        terminate(&dotTunnelProcess, owned: &dotTunnelOwned)
        terminate(&tunnelProcess, owned: &tunnelOwned)
        terminate(&backendProcess, owned: &backendOwned)
        publishSnapshot()
    }

    func restart() {
        stop()
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.4) {
            self.start()
        }
    }

    func setupTunnel(tunnelID: String?, apiKey: String) {
        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try KeychainStore.save(apiKey: trimmed)
                if !self.hasTunnelProfile() {
                    let trimmedTunnelID = tunnelID?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    guard !trimmedTunnelID.isEmpty else {
                        throw DesktopError.message("Tunnel ID is required for first-time setup.")
                    }
                    let result = try self.runAndWait(
                        executable: self.tunnelExecutable,
                        arguments: [
                            "init",
                            "--profile-dir", self.profileDirectory.path,
                            "--profile", "openchatx",
                            "--tunnel-id", trimmedTunnelID,
                            "--mcp-server-url", self.mcpServerURL,
                            "--health-listen-addr", self.tunnelHealthListenAddress,
                            "--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY",
                            "--force"
                        ],
                        environment: self.runtimeEnvironment(apiKey: trimmed)
                    )
                    guard result == 0 else {
                        throw DesktopError.message("tunnel-client init exited with code \(result)")
                    }
                }
                if !self.isTunnelHealthy() {
                    try self.startTunnel()
                }
            } catch {
                self.appendDesktopLog("Tunnel setup failed: \(error.localizedDescription)")
            }
            self.publishSnapshot()
        }
    }

    func setupDotTunnel(tunnelID: String?, apiKey: String, completion: ((String?) -> Void)? = nil) {
        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedTunnelID = tunnelID?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard isDotEnabled else {
            completion?("Dot is not enabled in Settings yet.")
            return
        }
        guard !trimmedKey.isEmpty else {
            completion?("API key is required.")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let profileName = self.dotProfileName
                let hasDotProfile = self.hasTunnelProfile(named: profileName)
                if !hasDotProfile {
                    guard !trimmedTunnelID.isEmpty else {
                        throw DesktopError.message("Tunnel ID is required for first-time Dot tunnel setup.")
                    }
                    if trimmedTunnelID == self.mainTunnelID() {
                        throw DesktopError.message("Dot Tunnel ID must differ from the main tunnel ID.")
                    }
                    try KeychainStore.save(apiKey: trimmedKey, account: KeychainStore.dotAccount)
                    let result = try self.runAndWait(
                        executable: self.tunnelExecutable,
                        arguments: [
                            "init",
                            "--profile-dir", self.profileDirectory.path,
                            "--profile", profileName,
                            "--tunnel-id", trimmedTunnelID,
                            "--mcp-server-url", self.dotMcpServerURL,
                            "--health-listen-addr", self.dotTunnelHealthListenAddress,
                            "--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY",
                            "--force"
                        ],
                        environment: self.runtimeEnvironment(apiKey: trimmedKey)
                    )
                    guard result == 0 else {
                        throw DesktopError.message("tunnel-client init exited with code \(result)")
                    }
                } else {
                    try KeychainStore.save(apiKey: trimmedKey, account: KeychainStore.dotAccount)
                }
                if !self.isTunnelHealthy(self.dotTunnelHealthURL) {
                    try self.startDotTunnel()
                }
                DispatchQueue.main.async { completion?(nil) }
            } catch {
                self.appendDesktopLog("Dot tunnel setup failed: \(error.localizedDescription)")
                DispatchQueue.main.async { completion?(error.localizedDescription) }
            }
            self.publishSnapshot()
        }
    }

    func mainTunnelID() -> String? {
        profileTunnelID(profile: "openchatx")
    }

    private func profileTunnelID(profile: String) -> String? {
        let url = profileDirectory.appendingPathComponent("\(profile).yaml")
        guard let source = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        for rawLine in source.split(whereSeparator: { $0.isNewline }) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("tunnel_id"), let equals = line.firstIndex(of: ":") else { continue }
            let rawValue = String(line[line.index(after: equals)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"\""))
            return rawValue.isEmpty ? nil : rawValue
        }
        return nil
    }

    func publishSnapshot() {
        DispatchQueue.global(qos: .utility).async {
            let dotEnabled = self.isDotEnabled
            let snapshot = Snapshot(
                backend: self.isHealthy(self.backendHealthURL),
                tunnel: self.isTunnelHealthy(),
                tunnelProfile: self.hasTunnelProfile(),
                dotEnabled: dotEnabled,
                dotTunnel: dotEnabled ? self.isTunnelHealthy(self.dotTunnelHealthURL) : false,
                dotTunnelProfile: dotEnabled ? self.hasTunnelProfile(named: self.dotProfileName) : false
            )
            DispatchQueue.main.async {
                self.onSnapshot?(snapshot)
            }
        }
    }

    func fetchDesktopPreferences(completion: @escaping (DesktopPreferences?) -> Void) {
        let url = dashboardURL.appendingPathComponent("api/recovery/state")
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard
                let http = response as? HTTPURLResponse,
                (200..<300).contains(http.statusCode),
                let data,
                let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let desktop = object["desktop"] as? [String: Any]
            else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            let closeToTray = desktop["closeToTray"] as? Bool ?? true
            let startMinimized = desktop["startMinimized"] as? Bool ?? false
            let notifications = object["notifications"] as? [String: Any]
            let notificationsEnabled = notifications?["enabled"] as? Bool ?? true
            let notifyTunnelDisconnected = notifications?["tunnelDisconnected"] as? Bool ?? true
            DispatchQueue.main.async {
                completion(
                    DesktopPreferences(
                        closeToTray: closeToTray,
                        startMinimized: startMinimized,
                        notificationsEnabled: notificationsEnabled,
                        notifyTunnelDisconnected: notifyTunnelDisconnected
                    )
                )
            }
        }.resume()
    }

    func setAgentAccessPaused(_ paused: Bool) {
        let url = dashboardURL.appendingPathComponent("api/runtime-control/pause")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 1.0
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["paused": paused, "stopRunning": paused]
        )
        URLSession.shared.dataTask(with: request).resume()
    }

    private func startBackend() throws {
        if backendProcess?.isRunning == true { return }
        let configDirectory = appSupport.appendingPathComponent("config", isDirectory: true)
        let process = Process()
        process.executableURL = nodeExecutable
        process.arguments = [runtimeRoot.appendingPathComponent("dist/index.js").path]
        process.currentDirectoryURL = runtimeRoot
        process.environment = runtimeEnvironment().merging([
            "OPENCHATX_PUBLIC_CONFIG": configDirectory.appendingPathComponent("openchatx.toml").path,
            "OPENCHATX_EXTERNAL_MCP_CONFIG": configDirectory.appendingPathComponent("mcp-servers.json").path,
            "OPENCHATX_SUBAGENT_CONFIG": configDirectory.appendingPathComponent("subagents.json").path,
            "OPENCHATX_TOOLBOX_ROOT": appSupport.appendingPathComponent("toolboxes").path,
            "OPENCHATX_AUDIT_LOG": logsDirectory.appendingPathComponent("agent-commands.yaml").path
        ]) { _, new in new }
        let log = try openLog("runtime.log")
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.backendOwned = false
            self.backendProcess = nil
            self.publishSnapshot()
        }
        try process.run()
        backendProcess = process
        backendOwned = true
        appendDesktopLog("Started OpenChatX runtime pid=\(process.processIdentifier)")
    }

    private func startTunnel() throws {
        if tunnelProcess?.isRunning == true { return }
        let process = Process()
        process.executableURL = tunnelExecutable
        process.arguments = [
            "run",
            "--profile-dir", profileDirectory.path,
            "--profile", "openchatx",
            "--mcp.server-url", "url=\(mcpServerURL)",
            "--health.listen-addr", tunnelHealthListenAddress
        ]
        process.currentDirectoryURL = runtimeRoot
        process.environment = runtimeEnvironment(apiKey: discoverTunnelAPIKey())
        let log = try openLog("tunnel.log")
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.tunnelOwned = false
            self.tunnelProcess = nil
            self.publishSnapshot()
        }
        try process.run()
        tunnelProcess = process
        tunnelOwned = true
        appendDesktopLog("Started tunnel-client pid=\(process.processIdentifier)")
    }

    private func startDotTunnel() throws {
        if dotTunnelProcess?.isRunning == true { return }
        let process = Process()
        process.executableURL = tunnelExecutable
        process.arguments = [
            "run",
            "--profile-dir", profileDirectory.path,
            "--profile", dotProfileName,
            "--mcp.server-url", "url=\(dotMcpServerURL)",
            "--health.listen-addr", dotTunnelHealthListenAddress
        ]
        process.currentDirectoryURL = runtimeRoot
        process.environment = runtimeEnvironment(apiKey: discoverDotTunnelAPIKey())
        let log = try openLog("dot-tunnel.log")
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.dotTunnelOwned = false
            self.dotTunnelProcess = nil
            self.publishSnapshot()
        }
        try process.run()
        dotTunnelProcess = process
        dotTunnelOwned = true
        appendDesktopLog("Started dot tunnel-client pid=\(process.processIdentifier)")
    }

    private var runtimePort: Int {
        readConfiguredPort(section: nil, key: "port", fallback: Self.defaultRuntimePort)
    }

    private var tunnelHealthPort: Int {
        readConfiguredPort(
            section: "tunnel",
            key: "health_port",
            fallback: Self.defaultTunnelHealthPort
        )
    }

    private func readConfiguredPort(section: String?, key: String, fallback: Int) -> Int {
        let config = appSupport
            .appendingPathComponent("config", isDirectory: true)
            .appendingPathComponent("openchatx.toml")
        guard let source = try? String(contentsOf: config, encoding: .utf8) else {
            return fallback
        }

        var currentSection: String?
        for rawLine in source.split(whereSeparator: { $0.isNewline }) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("[") && line.hasSuffix("]") {
                currentSection = String(line.dropFirst().dropLast())
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                continue
            }
            guard currentSection == section else { continue }
            guard line.hasPrefix(key), let equals = line.firstIndex(of: "=") else { continue }
            let valueStart = line.index(after: equals)
            let rawValue = line[valueStart...].split(separator: "#", maxSplits: 1)[0]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let port = Int(rawValue), (1...65535).contains(port) { return port }
        }
        return fallback
    }

    private func readConfiguredString(section: String, key: String, fallback: String) -> String {
        guard let raw = readConfiguredRaw(section: section, key: key) else { return fallback }
        let unquoted = raw.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        return unquoted.isEmpty ? fallback : unquoted
    }

    private func readConfiguredBool(section: String, key: String, fallback: Bool) -> Bool {
        guard let raw = readConfiguredRaw(section: section, key: key) else { return fallback }
        switch raw.lowercased() {
        case "true": return true
        case "false": return false
        default: return fallback
        }
    }

    private func readConfiguredRaw(section: String, key: String) -> String? {
        let config = appSupport
            .appendingPathComponent("config", isDirectory: true)
            .appendingPathComponent("openchatx.toml")
        guard let source = try? String(contentsOf: config, encoding: .utf8) else { return nil }
        var currentSection: String?
        for rawLine in source.split(whereSeparator: { $0.isNewline }) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("[") && line.hasSuffix("]") {
                currentSection = String(line.dropFirst().dropLast())
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                continue
            }
            guard currentSection == section else { continue }
            guard line.hasPrefix(key), let equals = line.firstIndex(of: "=") else { continue }
            let rawValue = line[line.index(after: equals)...].split(separator: "#", maxSplits: 1)[0]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return rawValue.isEmpty ? nil : rawValue
        }
        return nil
    }

    private func migrateLegacyRuntimePort(_ config: URL) throws {
        guard var source = try? String(contentsOf: config, encoding: .utf8) else { return }
        var lines = source.components(separatedBy: .newlines)

        for index in lines.indices {
            let line = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("[") { break }
            guard line.hasPrefix("port"), let equals = line.firstIndex(of: "=") else { continue }
            let rawValue = line[line.index(after: equals)...].split(separator: "#", maxSplits: 1)[0]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard rawValue == "3333" else { break }
            guard let range = lines[index].range(of: "3333") else { break }
            lines[index].replaceSubrange(range, with: String(Self.defaultRuntimePort))
            source = lines.joined(separator: "\n")
            try source.write(to: config, atomically: true, encoding: .utf8)
            return
        }
    }

    private func migrateLegacyTunnelProfile() throws {
        let destination = profileDirectory.appendingPathComponent("openchatx.yaml")
        guard !fileManager.fileExists(atPath: destination.path) else { return }

        let legacy = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("tunnel-client", isDirectory: true)
            .appendingPathComponent("openchatx.yaml")
        guard fileManager.fileExists(atPath: legacy.path) else { return }
        try fileManager.copyItem(at: legacy, to: destination)
        appendDesktopLog("Migrated existing tunnel profile into OpenChatX app data.")
    }

    private func discoverTunnelAPIKey() -> String? {
        if let key = KeychainStore.loadAPIKey(), !key.isEmpty { return key }
        if let key = ProcessInfo.processInfo.environment["CONTROL_PLANE_API_KEY"], !key.isEmpty {
            return key
        }

        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "printf %s \"$CONTROL_PLANE_API_KEY\""]
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let value = String(decoding: data, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        } catch {
            return nil
        }
    }

    private func discoverDotTunnelAPIKey() -> String? {
        if let key = KeychainStore.loadAPIKey(account: KeychainStore.dotAccount), !key.isEmpty {
            return key
        }
        return discoverTunnelAPIKey()
    }

    private func runtimeEnvironment(apiKey: String? = nil) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let bundledBin = runtimeRoot.appendingPathComponent("bin").path
        let inherited = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = "\(bundledBin):/opt/homebrew/bin:/usr/local/bin:\(inherited)"
        if let apiKey, !apiKey.isEmpty {
            environment["CONTROL_PLANE_API_KEY"] = apiKey
        } else {
            environment.removeValue(forKey: "CONTROL_PLANE_API_KEY")
        }
        environment["OPENCHATX_DESKTOP"] = "1"
        environment["OPENCHATX_DESKTOP_APP_PATH"] = Bundle.main.bundleURL.path
        environment["OPENCHATX_DESKTOP_APP_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        return environment
    }

    private func hasTunnelProfile(named name: String = "openchatx") -> Bool {
        do {
            let pipe = Pipe()
            let process = Process()
            process.executableURL = tunnelExecutable
            process.arguments = ["profiles", "list", "--profile-dir", profileDirectory.path]
            process.standardOutput = pipe
            process.standardError = Pipe()
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return false }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let text = String(decoding: data, as: UTF8.self)
            return text.split(separator: "\n").contains { line in
                line.split(separator: "\t").first == Substring(name)
            }
        } catch {
            return false
        }
    }

    private func isHealthy(_ url: URL) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.7
        request.setValue("close", forHTTPHeaderField: "Connection")
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse {
                healthy = (200..<300).contains(http.statusCode)
            }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 1.0)
        task.cancel()
        session.invalidateAndCancel()
        return healthy
    }

    private func isTunnelHealthy() -> Bool {
        isTunnelHealthy(tunnelHealthURL)
    }

    private func isTunnelHealthy(_ url: URL) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.7
        request.setValue("close", forHTTPHeaderField: "Connection")
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard
                let http = response as? HTTPURLResponse,
                (200..<300).contains(http.statusCode),
                let data,
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                json["live"] as? Bool == true,
                let components = json["components"] as? [String: Any],
                let controlPlane = components["control-plane"] as? [String: Any],
                controlPlane["status"] as? String == "ok"
            else { return }
            healthy = true
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 1.0)
        task.cancel()
        session.invalidateAndCancel()
        return healthy
    }

    private func waitUntilHealthy(_ url: URL, attempts: Int) -> Bool {
        for _ in 0..<attempts {
            if isHealthy(url) { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    private func terminate(_ process: inout Process?, owned: inout Bool) {
        guard owned, let value = process, value.isRunning else {
            process = nil
            owned = false
            return
        }
        value.terminate()
        let deadline = Date().addingTimeInterval(3)
        while value.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if value.isRunning {
            kill(value.processIdentifier, SIGKILL)
        }
        process = nil
        owned = false
    }

    private func openLog(_ name: String) throws -> FileHandle {
        let url = logsDirectory.appendingPathComponent(name)
        if !fileManager.fileExists(atPath: url.path) {
            fileManager.createFile(atPath: url.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        return handle
    }

    private func appendDesktopLog(_ message: String) {
        do {
            let handle = try openLog("desktop.log")
            let timestamp = ISO8601DateFormatter().string(from: Date())
            let data = Data("[\(timestamp)] \(message)\n".utf8)
            try handle.write(contentsOf: data)
            try handle.close()
        } catch {
            NSLog("OpenChatX desktop log error: \(error.localizedDescription)")
        }
    }

    private func copyDefault(from source: URL, to destination: URL) throws {
        guard !fileManager.fileExists(atPath: destination.path) else { return }
        try fileManager.copyItem(at: source, to: destination)
    }

    private func syncDefaultToolboxes(from sourceRoot: URL, to destinationRoot: URL) throws {
        try fileManager.createDirectory(at: destinationRoot, withIntermediateDirectories: true)
        let defaultToolboxes = try fileManager.contentsOfDirectory(
            at: sourceRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        for sourceToolbox in defaultToolboxes {
            let values = try sourceToolbox.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else { continue }
            let destinationToolbox = destinationRoot.appendingPathComponent(
                sourceToolbox.lastPathComponent,
                isDirectory: true
            )
            if !fileManager.fileExists(atPath: destinationToolbox.path) {
                try fileManager.copyItem(at: sourceToolbox, to: destinationToolbox)
                continue
            }

            try syncBuiltinToolboxManifest(from: sourceToolbox, to: destinationToolbox)

            let sourceSkills = sourceToolbox.appendingPathComponent("skills", isDirectory: true)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: sourceSkills.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else { continue }
            let destinationSkills = destinationToolbox.appendingPathComponent("skills", isDirectory: true)
            try fileManager.createDirectory(at: destinationSkills, withIntermediateDirectories: true)
            for sourceSkill in try fileManager.contentsOfDirectory(
                at: sourceSkills,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) {
                let skillValues = try sourceSkill.resourceValues(forKeys: [.isDirectoryKey])
                guard skillValues.isDirectory == true else { continue }
                let destinationSkill = destinationSkills.appendingPathComponent(
                    sourceSkill.lastPathComponent,
                    isDirectory: true
                )
                if !fileManager.fileExists(atPath: destinationSkill.path) {
                    try fileManager.copyItem(at: sourceSkill, to: destinationSkill)
                }
            }
        }
    }

    private func syncBuiltinToolboxManifest(from sourceToolbox: URL, to destinationToolbox: URL) throws {
        let sourceManifestURL = sourceToolbox.appendingPathComponent("toolbox.json")
        let destinationManifestURL = destinationToolbox.appendingPathComponent("toolbox.json")
        guard
            fileManager.fileExists(atPath: sourceManifestURL.path),
            fileManager.fileExists(atPath: destinationManifestURL.path)
        else { return }

        let sourceData = try Data(contentsOf: sourceManifestURL)
        let destinationData = try Data(contentsOf: destinationManifestURL)
        guard
            var source = try JSONSerialization.jsonObject(with: sourceData) as? [String: Any],
            let destination = try JSONSerialization.jsonObject(with: destinationData) as? [String: Any],
            source["builtin"] as? String != nil
        else { return }

        if let enabled = destination["enabled"] {
            source["enabled"] = enabled
        }

        if var sourceTools = source["tools"] as? [String: Any],
           let destinationTools = destination["tools"] as? [String: Any] {
            for (name, rawSourceTool) in sourceTools {
                guard
                    var sourceTool = rawSourceTool as? [String: Any],
                    let destinationTool = destinationTools[name] as? [String: Any],
                    let enabled = destinationTool["enabled"]
                else { continue }
                sourceTool["enabled"] = enabled
                sourceTools[name] = sourceTool
            }
            source["tools"] = sourceTools
        }

        var output = try JSONSerialization.data(
            withJSONObject: source,
            options: [.prettyPrinted, .sortedKeys]
        )
        output.append(0x0A)
        try output.write(to: destinationManifestURL, options: .atomic)
    }

    private func runAndWait(
        executable: URL,
        arguments: [String],
        environment: [String: String]
    ) throws -> Int32 {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardOutput = try openLog("tunnel.log")
        process.standardError = process.standardOutput
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
}

enum KeychainStore {
    private static let service = "com.openchatx.desktop"
    static let defaultAccount = "CONTROL_PLANE_API_KEY"
    static let dotAccount = "CONTROL_PLANE_API_KEY_DOT"

    static func save(apiKey: String, account: String = defaultAccount) throws {
        let data = Data(apiKey.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(base as CFDictionary)
        var item = base
        item[kSecValueData as String] = data
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw DesktopError.message("Could not store tunnel credential in Keychain (\(status)).")
        }
    }

    static func loadAPIKey(account: String = defaultAccount) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}

enum DesktopError: Error {
    case message(String)
}

extension DesktopError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

private extension NSToolbarItem.Identifier {
    static let runtimeControl = NSToolbarItem.Identifier("openchatx.runtime-control")
    static let moreActions = NSToolbarItem.Identifier("openchatx.more-actions")
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSToolbarDelegate {
    private let supervisor = RuntimeSupervisor()
    private var window: NSWindow!
    private var webView: WKWebView!
    private var runtimeToolbarItem: NSToolbarItem?
    private var moreToolbarItem: NSMenuToolbarItem?
    private var timer: Timer?
    private var lastSnapshot: RuntimeSupervisor.Snapshot?
    private var statusItem: NSStatusItem?
    private var desktopPreferencesLoaded = false
    private var closeToTray = true
    private var notificationsEnabled = true
    private var tunnelDisconnectedNotificationsEnabled = true

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()
        buildWindow()
        buildStatusItem()
        supervisor.onSnapshot = { [weak self] snapshot in
            self?.render(snapshot)
        }
        supervisor.start()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            DispatchQueue.global(qos: .utility).async {
                self.supervisor.maintainRuntime()
                self.supervisor.publishSnapshot()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        supervisor.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !closeToTray
    }

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = NSImage(
                systemSymbolName: "bubble.left.and.bubble.right.fill",
                accessibilityDescription: "OpenChatX"
            )
            button.toolTip = "OpenChatX"
        }

        let menu = NSMenu()
        menu.addItem(
            withTitle: "Open OpenChatX",
            action: #selector(showMainWindow),
            keyEquivalent: ""
        )
        menu.addItem(.separator())
        menu.addItem(
            withTitle: "Pause Agent Access",
            action: #selector(pauseAgentAccess),
            keyEquivalent: ""
        )
        menu.addItem(
            withTitle: "Resume Agent Access",
            action: #selector(resumeAgentAccess),
            keyEquivalent: ""
        )
        menu.addItem(.separator())
        menu.addItem(
            withTitle: "Quit OpenChatX",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        item.menu = menu
        statusItem = item
    }

    @objc private func showMainWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func pauseAgentAccess() {
        supervisor.setAgentAccessPaused(true)
    }

    @objc private func resumeAgentAccess() {
        supervisor.setAgentAccessPaused(false)
    }

    private func applyDesktopPreferencesIfNeeded(_ snapshot: RuntimeSupervisor.Snapshot) {
        guard snapshot.backend else { return }
        supervisor.fetchDesktopPreferences { [weak self] preferences in
            guard let self, let preferences else { return }
            let firstLoad = !self.desktopPreferencesLoaded
            self.desktopPreferencesLoaded = true
            self.closeToTray = preferences.closeToTray
            self.notificationsEnabled = preferences.notificationsEnabled
            self.tunnelDisconnectedNotificationsEnabled = preferences.notifyTunnelDisconnected
            if firstLoad, preferences.startMinimized {
                self.window.orderOut(nil)
            }
        }
    }

    private func notifyTunnelDisconnected() {
        guard notificationsEnabled, tunnelDisconnectedNotificationsEnabled else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = [
            "-e",
            "display notification \"The Secure MCP Tunnel lost its control-plane connection.\" with title \"OpenChatX Tunnel disconnected\""
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    private func buildMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu(title: "OpenChatX")
        appMenuItem.submenu = appMenu
        appMenu.addItem(
            withTitle: "Quit OpenChatX",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(
            withTitle: "Paste and Match Style",
            action: #selector(NSTextView.pasteAsPlainText(_:)),
            keyEquivalent: "V"
        )
        editMenu.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        editMenu.addItem(.separator())
        editMenu.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )

        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OpenChatX"
        window.center()
        window.minSize = NSSize(width: 900, height: 620)
        window.tabbingMode = .disallowed
        window.toolbarStyle = .unifiedCompact

        let toolbar = NSToolbar(identifier: "openchatx.main-toolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        toolbar.autosavesConfiguration = false
        window.toolbar = toolbar

        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = root

        webView = WKWebView()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(webView)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webView.topAnchor.constraint(equalTo: root.topAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        showStartingPage()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            .flexibleSpace,
            .runtimeControl,
            .moreActions,
        ]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            .flexibleSpace,
            .runtimeControl,
            .moreActions,
        ]
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch itemIdentifier {
        case .runtimeControl:
            let item = toolbarButton(
                identifier: itemIdentifier,
                label: "Start Runtime",
                symbol: "play.fill",
                action: #selector(toggleRuntime)
            )
            runtimeToolbarItem = item
            return item
        case .moreActions:
            let item = NSMenuToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "More"
            item.paletteLabel = "More"
            item.toolTip = "More"
            item.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: "More")
            item.menu = makeMoreMenu()
            moreToolbarItem = item
            return item
        default:
            return nil
        }
    }

    private func toolbarButton(
        identifier: NSToolbarItem.Identifier,
        label: String,
        symbol: String,
        action: Selector
    ) -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = label
        item.paletteLabel = label
        item.toolTip = label
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        item.target = self
        item.action = action
        return item
    }

    private func render(_ snapshot: RuntimeSupervisor.Snapshot) {
        let previous = lastSnapshot
        lastSnapshot = snapshot
        runtimeToolbarItem?.label = snapshot.backend ? "Stop Runtime" : "Start Runtime"
        runtimeToolbarItem?.toolTip = runtimeToolbarItem?.label
        runtimeToolbarItem?.image = NSImage(
            systemSymbolName: snapshot.backend ? "stop.fill" : "play.fill",
            accessibilityDescription: runtimeToolbarItem?.label
        )
        moreToolbarItem?.menu = makeMoreMenu()
        applyDesktopPreferencesIfNeeded(snapshot)
        if previous?.tunnel == true, !snapshot.tunnel, snapshot.tunnelProfile {
            notifyTunnelDisconnected()
        }

        if snapshot.backend {
            let dashboardURL = supervisor.dashboardURL
            if webView.url?.host != dashboardURL.host || webView.url?.port != dashboardURL.port {
                webView.load(URLRequest(url: dashboardURL))
            }
        } else {
            showStartingPage()
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    private func showStartingPage() {
        webView.loadHTMLString(
            """
            <html>
            <head>
              <meta name="color-scheme" content="light dark">
              <style>
                :root {
                  color-scheme: light dark;
                  --bg: #f7f7f7;
                  --fg: #222225;
                  --muted: #6e6e73;
                }
                @media (prefers-color-scheme: dark) {
                  :root {
                    --bg: #1c1c1e;
                    --fg: #f2f2f7;
                    --muted: #aeaeb2;
                  }
                }
                body {
                  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  height: 100vh;
                  margin: 0;
                  background: var(--bg);
                  color: var(--fg);
                }
                .startup { text-align: center; }
                .startup h2 { margin: 0; font-size: 28px; }
                .startup p { margin: 18px 0 0; color: var(--muted); font-size: 16px; }
              </style>
            </head>
            <body>
              <div class="startup"><h2>OpenChatX</h2><p>Starting local capability runtime…</p></div>
            </body>
            </html>
            """,
            baseURL: nil
        )
    }

    @objc private func toggleRuntime() {
        if lastSnapshot?.backend == true {
            supervisor.stop()
        } else {
            supervisor.start()
        }
    }

    @objc private func restartRuntime() { supervisor.restart() }

    @objc private func openLogs() {
        NSWorkspace.shared.open(supervisor.logsDirectory)
    }

    private func makeMoreMenu() -> NSMenu {
        let menu = NSMenu(title: "")

        let restart = NSMenuItem(
            title: "Restart Runtime",
            action: #selector(restartRuntime),
            keyEquivalent: ""
        )
        restart.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        restart.target = self
        restart.isEnabled = lastSnapshot?.backend == true
        menu.addItem(restart)

        let tunnel = NSMenuItem(
            title: lastSnapshot?.tunnel == true ? "Tunnel Connected" : "Connect Tunnel…",
            action: #selector(setupTunnel),
            keyEquivalent: ""
        )
        tunnel.image = NSImage(systemSymbolName: "link", accessibilityDescription: nil)
        tunnel.target = self
        tunnel.isEnabled = lastSnapshot?.tunnel != true
        menu.addItem(tunnel)

        let dotTunnelItem = NSMenuItem(
            title: lastSnapshot?.dotTunnel == true ? "Dot Tunnel Connected" : "Connect Dot Tunnel…",
            action: #selector(setupDotTunnelViaMenu),
            keyEquivalent: ""
        )
        dotTunnelItem.image = NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: nil)
        dotTunnelItem.target = self
        dotTunnelItem.isEnabled = lastSnapshot?.dotEnabled == true && lastSnapshot?.dotTunnel != true
        menu.addItem(dotTunnelItem)

        menu.addItem(.separator())

        let logs = NSMenuItem(title: "Open Logs", action: #selector(openLogs), keyEquivalent: "")
        logs.image = NSImage(
            systemSymbolName: "doc.text.magnifyingglass",
            accessibilityDescription: nil
        )
        logs.target = self
        menu.addItem(logs)

        return menu
    }

    @objc private func setupTunnel() {
        let hasProfile = lastSnapshot?.tunnelProfile ?? false
        let alert = NSAlert()
        alert.messageText = "Connect OpenAI Secure MCP Tunnel"
        alert.informativeText = hasProfile
            ? "Enter the tunnel control-plane API key. It is stored only in your macOS Keychain and passed to tunnel-client locally."
            : "Enter the Tunnel ID and control-plane API key from your OpenAI tunnel setup. The API key is stored only in your macOS Keychain."
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.frame = NSRect(x: 0, y: 0, width: 380, height: hasProfile ? 54 : 98)

        var tunnelIDField: NSTextField?
        if !hasProfile {
            stack.addArrangedSubview(NSTextField(labelWithString: "Tunnel ID"))
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
            field.placeholderString = "tun_…"
            field.widthAnchor.constraint(equalToConstant: 380).isActive = true
            stack.addArrangedSubview(field)
            tunnelIDField = field
        }

        stack.addArrangedSubview(NSTextField(labelWithString: "Control-plane API key"))
        let apiKeyField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
        apiKeyField.placeholderString = "API key"
        apiKeyField.widthAnchor.constraint(equalToConstant: 380).isActive = true
        stack.addArrangedSubview(apiKeyField)

        alert.accessoryView = stack
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        supervisor.setupTunnel(tunnelID: tunnelIDField?.stringValue, apiKey: apiKeyField.stringValue)
    }

    @objc private func setupDotTunnelViaMenu() {
        let alert = NSAlert()
        alert.messageText = "Connect Dot Tunnel (second OpenAI tunnel)"
        alert.informativeText = "Enter a Tunnel ID that is different from the main tunnel, plus its control-plane API key. The key is stored only in your macOS Keychain."
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.frame = NSRect(x: 0, y: 0, width: 380, height: 98)

        stack.addArrangedSubview(NSTextField(labelWithString: "Dot Tunnel ID (must differ from main)"))
        let tunnelIDField = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
        tunnelIDField.placeholderString = "tun_…"
        tunnelIDField.widthAnchor.constraint(equalToConstant: 380).isActive = true
        stack.addArrangedSubview(tunnelIDField)

        stack.addArrangedSubview(NSTextField(labelWithString: "Control-plane API key"))
        let apiKeyField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
        apiKeyField.placeholderString = "API key"
        apiKeyField.widthAnchor.constraint(equalToConstant: 380).isActive = true
        stack.addArrangedSubview(apiKeyField)

        alert.accessoryView = stack
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        supervisor.setupDotTunnel(
            tunnelID: tunnelIDField.stringValue,
            apiKey: apiKeyField.stringValue
        ) { error in
            guard let error else { return }
            let failure = NSAlert()
            failure.messageText = "Dot tunnel setup failed"
            failure.informativeText = error
            failure.alertStyle = .warning
            failure.runModal()
        }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
