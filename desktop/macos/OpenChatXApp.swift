import AppKit
import Foundation
import Security
import WebKit

private let dashboardURL = URL(string: "http://127.0.0.1:3333/ui/")!
private let backendHealthURL = URL(string: "http://127.0.0.1:3333/healthz")!
private let tunnelHealthURL = URL(string: "http://127.0.0.1:8080/health?details=true")!

final class RuntimeSupervisor: NSObject {
    struct Snapshot {
        let backend: Bool
        let tunnel: Bool
        let tunnelProfile: Bool
    }

    private var backendProcess: Process?
    private var tunnelProcess: Process?
    private(set) var backendOwned = false
    private(set) var tunnelOwned = false

    let appSupport: URL
    let logsDirectory: URL
    private let profileDirectory: URL
    private let runtimeRoot: URL
    private let nodeExecutable: URL
    private let tunnelExecutable: URL
    private let fileManager = FileManager.default

    var onSnapshot: ((Snapshot) -> Void)?

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

        try copyDefault(
            from: runtimeRoot.appendingPathComponent(".openchatx/config.toml"),
            to: configDirectory.appendingPathComponent("openchatx.toml")
        )
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
        } catch {
            appendDesktopLog("Runtime maintenance failed: \(error.localizedDescription)")
        }
    }

    func stop() {
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
                            "--mcp-server-url", "http://127.0.0.1:3333/mcp",
                            "--health-listen-addr", "127.0.0.1:8080",
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

    func publishSnapshot() {
        DispatchQueue.global(qos: .utility).async {
            let snapshot = Snapshot(
                backend: self.isHealthy(backendHealthURL),
                tunnel: self.isTunnelHealthy(),
                tunnelProfile: self.hasTunnelProfile()
            )
            DispatchQueue.main.async {
                self.onSnapshot?(snapshot)
            }
        }
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
            "--health.listen-addr", "127.0.0.1:8080"
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
        return environment
    }

    private func hasTunnelProfile() -> Bool {
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
                line.split(separator: "\t").first == "openchatx"
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
        let task = URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse {
                healthy = (200..<300).contains(http.statusCode)
            }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 1.0)
        task.cancel()
        return healthy
    }

    private func isTunnelHealthy() -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        var request = URLRequest(url: tunnelHealthURL)
        request.timeoutInterval = 0.7
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
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
    private static let account = "CONTROL_PLANE_API_KEY"

    static func save(apiKey: String) throws {
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

    static func loadAPIKey() -> String? {
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()
        buildWindow()
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
        true
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
        lastSnapshot = snapshot
        runtimeToolbarItem?.label = snapshot.backend ? "Stop Runtime" : "Start Runtime"
        runtimeToolbarItem?.toolTip = runtimeToolbarItem?.label
        runtimeToolbarItem?.image = NSImage(
            systemSymbolName: snapshot.backend ? "stop.fill" : "play.fill",
            accessibilityDescription: runtimeToolbarItem?.label
        )
        moreToolbarItem?.menu = makeMoreMenu()

        if snapshot.backend {
            if webView.url?.host != dashboardURL.host {
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
            <html><body style="font-family:-apple-system;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f7;color:#333">
            <div style="text-align:center"><h2>OpenChatX</h2><p>Starting local capability runtime…</p></div>
            </body></html>
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
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
