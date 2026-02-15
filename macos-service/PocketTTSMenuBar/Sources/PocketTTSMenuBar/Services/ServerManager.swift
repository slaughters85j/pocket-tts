import Foundation

enum ServerStatus {
    case running
    case stopped
    case unknown
    case restarting
}

struct HealthResponse: Codable {
    let status: String
}

@MainActor
class ServerManager: ObservableObject {
    @Published private(set) var status: ServerStatus = .unknown

    static let shared = ServerManager()

    private var checkTask: Task<Void, Never>?

    private init() {
        // Start periodic health checks
        startPeriodicHealthCheck()
    }

    // Check server health
    func checkHealth() async {
        let configManager = ConfigManager.shared
        let urlString = "\(configManager.serverURL)/health"

        guard let url = URL(string: urlString) else {
            status = .stopped
            return
        }

        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 2.0
            request.httpMethod = "GET"

            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                status = .stopped
                return
            }

            let decoder = JSONDecoder()
            let healthResponse = try decoder.decode(HealthResponse.self, from: data)

            if healthResponse.status == "healthy" {
                status = .running
            } else {
                status = .stopped
            }
        } catch {
            status = .stopped
        }
    }

    // Start periodic health checks (every 10 seconds)
    private func startPeriodicHealthCheck() {
        checkTask?.cancel()

        checkTask = Task {
            while !Task.isCancelled {
                await checkHealth()
                try? await Task.sleep(nanoseconds: 10_000_000_000) // 10 seconds
            }
        }
    }

    // Stop health checks
    func stopHealthCheck() {
        checkTask?.cancel()
        checkTask = nil
    }

    // Restart health checks
    func restartHealthCheck() {
        startPeriodicHealthCheck()
    }

    deinit {
        checkTask?.cancel()
    }

    // MARK: - Service Restart

    /// Run a shell command off the main thread and return exit code + output.
    private nonisolated func runProcess(
        _ executable: String,
        arguments: [String]
    ) async throws -> (exitCode: Int32, output: String) {
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments

                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe

                do {
                    try process.run()
                    let outputData = pipe.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    let output = String(data: outputData, encoding: .utf8) ?? ""
                    continuation.resume(returning: (process.terminationStatus, output))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Restart the TTS server via launchctl.
    /// Uses `kickstart -k` (preferred) with fallback to unload/load.
    func restartService() async -> Bool {
        // 1. Update status to restarting
        status = .restarting
        stopHealthCheck()

        let uid = getuid()
        let serviceTarget = "gui/\(uid)/\(Constants.launchAgentLabel)"
        var restartSucceeded = false

        // 2. Try launchctl kickstart -k (modern, atomic restart)
        do {
            let result = try await runProcess("/bin/launchctl", arguments: [
                "kickstart", "-k", serviceTarget
            ])
            print("launchctl kickstart exit code: \(result.exitCode)")
            print("launchctl kickstart output: \(result.output)")
            restartSucceeded = (result.exitCode == 0)
        } catch {
            print("launchctl kickstart failed: \(error)")
        }

        // 3. Fallback: unload then load
        if !restartSucceeded {
            print("Falling back to unload/load pattern...")
            let plistPath = Constants.launchAgentPlistPath

            do {
                let unloadResult = try await runProcess("/bin/launchctl", arguments: [
                    "unload", plistPath
                ])
                print("launchctl unload exit code: \(unloadResult.exitCode)")
            } catch {
                print("launchctl unload error: \(error)")
            }

            try? await Task.sleep(nanoseconds: 500_000_000) // 0.5s

            do {
                let loadResult = try await runProcess("/bin/launchctl", arguments: [
                    "load", plistPath
                ])
                print("launchctl load exit code: \(loadResult.exitCode)")
                restartSucceeded = (loadResult.exitCode == 0)
            } catch {
                print("launchctl load error: \(error)")
            }
        }

        // 4. Poll for health (server needs time to initialize)
        try? await Task.sleep(nanoseconds: 2_000_000_000) // 2s

        var healthy = false
        for attempt in 1...10 {
            await checkHealth()
            if status == .running {
                healthy = true
                print("Server healthy after restart (attempt \(attempt))")
                break
            }
            print("Health check attempt \(attempt)/10 - not ready yet")
            try? await Task.sleep(nanoseconds: 1_000_000_000) // 1s
        }

        // 5. Set final status
        if !healthy {
            status = .stopped
        }

        // 6. Resume periodic health checks
        restartHealthCheck()
        return healthy
    }
}
