import Foundation
import AppKit
import UserNotifications

/// CLI tool for Quick Action TTS
/// Usage: pocket-tts-quick-action "text to speak"

// MARK: - Global References for Signal Handlers

// These must be global so signal handlers (which are C function pointers) can access them.
var globalClient: TTSClient?
var globalPlayer: StreamingWAVPlayer?
var globalSemaphore: DispatchSemaphore?

/// Path to the PID file used by the Menu Bar app to send stop signals
let pidFilePath = Constants.appSupportDirectory.appendingPathComponent(".tts-pid")

// MARK: - PID File Management

func writePIDFile() {
    let pid = ProcessInfo.processInfo.processIdentifier
    try? FileManager.default.createDirectory(
        at: Constants.appSupportDirectory,
        withIntermediateDirectories: true
    )
    try? "\(pid)".write(to: pidFilePath, atomically: true, encoding: .utf8)
}

func removePIDFile() {
    try? FileManager.default.removeItem(at: pidFilePath)
}

// MARK: - Signal Handling

// Dispatch sources that handle signals safely on a GCD queue (not in signal context).
// Stored globally to prevent deallocation.
var sigtermSource: DispatchSourceSignal?
var sigintSource: DispatchSourceSignal?

/// Installs signal handlers using GCD dispatch sources.
///
/// POSIX `signal()` handlers can only call async-signal-safe functions.
/// Swift method calls, Foundation I/O, print(), and ARC operations are all
/// unsafe in signal context. `DispatchSource.makeSignalSource` delivers signals
/// as GCD events on a normal queue where arbitrary Swift code is safe to run.
func installSignalHandlers() {
    // Block default signal handling — dispatch sources require this
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termSource.setEventHandler {
        print("\nReceived SIGTERM, stopping...")
        handleShutdown()
    }
    termSource.resume()
    sigtermSource = termSource

    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    intSource.setEventHandler {
        print("\nReceived SIGINT, stopping...")
        handleShutdown()
    }
    intSource.resume()
    sigintSource = intSource
}

/// Performs graceful shutdown — safe to call from any GCD queue context.
func handleShutdown() {
    globalClient?.cancel()
    globalPlayer?.stop()
    removePIDFile()
    globalSemaphore?.signal()
}

// MARK: - Main Entry Point

func main() {
    // Check command-line arguments
    let arguments = CommandLine.arguments

    guard arguments.count >= 2 else {
        printError("Usage: pocket-tts-quick-action \"text to speak\"")
        exit(1)
    }

    // Get text from arguments (join all arguments after the first)
    let text = arguments[1...].joined(separator: " ")

    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        printError("Error: Text cannot be empty")
        exit(1)
    }

    // Load configuration
    let config = ConfigManager.loadConfig()
    let serverURL = ConfigManager.getServerURL()

    // Get selected voice
    guard let voice = VoiceManager.getVoice(withId: config.selectedVoiceId) else {
        printError("Error: Selected voice '\(config.selectedVoiceId)' not found")
        exit(1)
    }

    print("Using voice: \(voice.name) (\(voice.type.rawValue))")
    print("Server: \(serverURL)")
    print("Generating speech...")

    // Write PID file so Menu Bar app can send stop signal
    writePIDFile()

    // Install signal handlers for graceful stop
    installSignalHandlers()

    // Create audio player
    let player = StreamingWAVPlayer()
    globalPlayer = player

    // Track completion
    let semaphore = DispatchSemaphore(value: 0)
    globalSemaphore = semaphore
    var hasError = false

    // Set up callbacks
    player.onFirstAudio = {
        print("Audio playback started")
    }

    player.onComplete = {
        print("Audio playback completed")
        semaphore.signal()
    }

    player.onError = { error in
        printError("Player error: \(error.localizedDescription)")
        hasError = true
        semaphore.signal()
    }

    // Create TTS client and make request
    let client = TTSClient(serverURL: serverURL)
    globalClient = client

    do {
        try client.streamSpeech(
            text: text,
            voiceId: config.selectedVoiceId,
            voiceType: config.selectedVoiceType,
            player: player
        )

        // Wait for playback to complete (or signal handler to fire)
        semaphore.wait()

        // Stop player
        player.stop()

        // Clean up PID file
        removePIDFile()

        // Exit with appropriate code
        exit(hasError ? 1 : 0)
    } catch {
        printError("Error: \(error.localizedDescription)")

        // Show notification to user
        showNotification(
            title: "Pocket TTS Error",
            message: error.localizedDescription
        )

        // Clean up PID file
        removePIDFile()

        exit(1)
    }
}

// MARK: - Helper Functions

func printError(_ message: String) {
    FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
}

func showNotification(title: String, message: String) {
    let center = UNUserNotificationCenter.current()

    // Request authorization (will be remembered after first grant)
    center.requestAuthorization(options: [.alert]) { granted, _ in
        guard granted else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil  // Deliver immediately
        )

        center.add(request)
    }
}

// MARK: - Run

// Run main() on a background queue so it can block on semaphore.wait().
// dispatchMain() properly drains GCD's main dispatch queue — unlike
// RunLoop.main.run(), which may not process GCD blocks in a command-line
// tool after AVAudioEngine goes idle. Signal dispatch sources and
// DispatchQueue.main.asyncAfter both depend on this.
DispatchQueue.global().async {
    main()
}

dispatchMain()
