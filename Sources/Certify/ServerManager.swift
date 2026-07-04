import Foundation
import Darwin

/// Runs the bundled Node.js server as a child process and reports when it
/// is ready to serve the UI.
@MainActor
final class ServerManager: ObservableObject {
    @Published var url: URL?
    @Published var errorMessage: String?

    private var process: Process?
    private var started = false

    func start() {
        guard !started else { return }
        started = true

        guard let resources = Bundle.main.resourceURL else {
            errorMessage = "App bundle is missing its resources."
            return
        }
        let nodeBinary = resources.appendingPathComponent("node")
        let serverScript = resources.appendingPathComponent("server/server.js")
        guard FileManager.default.fileExists(atPath: serverScript.path) else {
            errorMessage = "Server files are missing from the app bundle. Rebuild with build.sh or release.sh."
            return
        }

        // Persistent state lives in Application Support — the signed app
        // bundle itself must never be written to.
        let dataDir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Certify", isDirectory: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)

        let port = Self.findFreePort()

        let process = Process()
        process.executableURL = nodeBinary
        process.arguments = [serverScript.path]
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["CERTIFY_DATA_DIR"] = dataDir.path
        process.environment = environment
        process.currentDirectoryURL = dataDir
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            errorMessage = "Could not start the local server: \(error.localizedDescription)"
            return
        }
        self.process = process

        Task { await waitUntilReady(port: port) }
    }

    nonisolated func stop() {
        Task { @MainActor in
            process?.terminate()
            process = nil
        }
    }

    private func waitUntilReady(port: UInt16) async {
        let target = URL(string: "http://127.0.0.1:\(port)/")!
        for _ in 0..<150 {
            if let process, !process.isRunning {
                errorMessage = "The local server exited unexpectedly."
                return
            }
            if let (_, response) = try? await URLSession.shared.data(from: target),
               (response as? HTTPURLResponse)?.statusCode == 200 {
                url = target
                return
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        errorMessage = "Timed out waiting for the local server to start."
    }

    /// Asks the kernel for an unused loopback port.
    private static func findFreePort() -> UInt16 {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return 8443 }
        defer { close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(sock, $0, len)
            }
        }
        guard bound == 0 else { return 8443 }
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(sock, $0, &len)
            }
        }
        let port = UInt16(bigEndian: addr.sin_port)
        return port == 0 ? 8443 : port
    }
}
