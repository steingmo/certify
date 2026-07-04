import SwiftUI

@main
struct CertifyApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var server = ServerManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(server)
                .frame(minWidth: 900, minHeight: 680)
                .onAppear {
                    appDelegate.server = server
                    server.start()
                }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var server: ServerManager?

    func applicationWillTerminate(_ notification: Notification) {
        server?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

struct ContentView: View {
    @EnvironmentObject var server: ServerManager

    var body: some View {
        Group {
            if let url = server.url {
                WebView(url: url)
            } else if let message = server.errorMessage {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 36))
                        .foregroundStyle(.yellow)
                    Text(message)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 420)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 16) {
                    ProgressView()
                    Text("Starting Certify…")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}
