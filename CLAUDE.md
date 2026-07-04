# Certify — project context

Native macOS app for requesting Let's Encrypt certificates with manual
DNS-01 validation (including wildcards). Writes certbot-style PEM files
and exports password-protected PFX bundles for Windows/IIS/RDS.
Distributed via GitHub Releases and a Homebrew tap (`steingmo/tap`,
cask `certify`); auto-updates via Sparkle.

## Architecture

**Thin native shell around a local Node.js server.** The SwiftUI app
spawns the bundled Node runtime running `server/server.js` on a free
localhost port and shows its web UI in a WKWebView. All ACME logic lives
in JavaScript; Swift only manages the process, window, downloads, and
updates.

Swift Package (no Xcode project). Swift sources in `Sources/Certify/`:

- `CertifyApp.swift` — `@main`, loading/error states, AppDelegate that
  terminates the server on quit; app quits when the last window closes.
- `ServerManager.swift` — launches `Resources/node` with
  `server/server.js` as a child process. Asks the kernel for a free
  loopback port (bind to port 0) and passes it as `PORT`; sets
  `CERTIFY_DATA_DIR` to `~/Library/Application Support/Certify` —
  **persistent state never goes inside the signed app bundle**. Polls
  `http://127.0.0.1:<port>/` until it returns 200 (up to ~30 s).
- `WebView.swift` — WKWebView wrapper. `WKDownloadDelegate` routes
  downloads (the PFX export) to a native `NSSavePanel`; JS alert/confirm
  become `NSAlert`s (WKWebView shows nothing for them by default).
- `Updater.swift` — Sparkle `SPUStandardUpdaterController` + "Check for
  Updates…" menu item; automatic background checks start with the app.

`server/` — the actual application (Node/Express + `acme-client` +
`node-forge`, UI is a single hand-written `public/index.html`, no
frontend build step). Endpoints mirror the user flow:
`POST /api/order` (create ACME order, return `_acme-challenge` TXT
records) → `GET /api/check-dns` (resolve via 1.1.1.1/8.8.8.8 to bypass
local caches) → `POST /api/issue` (complete challenges, finalize, write
`cert/chain/fullchain/privkey.pem` to `<folder>/<domain>/`) →
`POST /api/export-pfx` / `GET /api/download`. Design decisions baked in:

- Pending orders live in an in-memory `Map` — single-user local tool,
  state is lost on restart by design.
- ACME account keys are per-environment (`account-staging.pem` /
  `account-production.pem`) in the data dir, created once and reused.
- Certificate keys are RSA 2048 and the PFX uses **3DES/SHA1
  deliberately** — maximum import compatibility on Windows Server
  2012R2–2025 (OpenSSL 3's AES-256 default breaks older importers).
- The server binds to 127.0.0.1 only.
- Runs standalone without the app: `cd server && npm install && npm
  start` → http://127.0.0.1:8443 (data dir defaults to `server/data/`).

`assets/node` — universal (arm64+x64) Node 22 runtime bundled into the
app so users install nothing. Not committed (~110 MB);
`assets/fetch-node.sh` downloads both official binaries and `lipo`s them
together. Build scripts fetch it automatically if missing.

`node.entitlements` — JIT + unsigned-executable-memory entitlements
that V8 needs under the hardened runtime; applied when release.sh signs
the bundled `node` binary.

## Building

- Dev: `./build.sh` — release build for the current arch, assembles
  `build/Certify.app` by hand (binary + Info.plist + icon + node +
  server files + embedded Sparkle.framework, rpath added via
  `install_name_tool`), ad-hoc signs. There is no Xcode project; the
  scripts *are* the bundle definition.
- Both scripts stage and sign in a temp dir under `/tmp` — iCloud's
  file provider re-stamps FinderInfo xattrs that codesign rejects as
  detritus. Never sign in place.
- `swift build` alone only checks the Swift shell compiles; it does not
  produce a runnable app (the server and node runtime are required).

## Releasing

Bump `CFBundleVersion` and `CFBundleShortVersionString` in `Info.plist`
first — release.sh reads the version from there, it does not take an
argument. Then `./release.sh`: universal (arm64+x86_64) build,
Developer ID signing with hardened runtime (Sparkle's nested XPC
services/Autoupdate/Updater.app each signed individually, `node` signed
with `node.entitlements`), notarization + stapling, packages
`build/Certify.zip`, and regenerates `appcast.xml` with the Sparkle
EdDSA signature. Unlike some sibling projects, release.sh does **not**
touch git/GitHub — it prints the remaining manual steps: commit + push
`appcast.xml`, `gh release create v<version> build/Certify.zip`, and
bump the Homebrew cask via the tap's `bump-cask.sh`.

The Sparkle feed is `appcast.xml` served raw from the main branch
(`SUFeedURL` in Info.plist); the release asset must be named exactly
`Certify.zip` to match the enclosure URL.

Machine requirements for releasing (not needed for code changes): a
Developer ID Application certificate in the keychain (override with
`CERTIFY_IDENTITY`), a notarytool keychain profile (default
`keytype-notary`, override with `CERTIFY_NOTARY_PROFILE`), the Sparkle
EdDSA private key in the login keychain (**never regenerate it** —
shipped apps only trust updates signed by the key matching
`SUPublicEDKey` in Info.plist), and an authenticated `gh` CLI.

## Testing

No XCTest target and no JS test suite. Practical verification:

- Server logic: run it standalone (`cd server && npm start`) and
  exercise the API/UI at http://127.0.0.1:8443. Always use the
  **Staging** environment — Production issuance counts against Let's
  Encrypt rate limits.
- Full app: `./build.sh && open build/Certify.app`. Note the app
  discards server stdout/stderr; when debugging server startup, run the
  server standalone to see its output.

## Conventions

- Keep the public repo free of personal identifiers (team IDs, Apple
  IDs, credential names beyond what already appears in the scripts).
- ACME behavior should match Let's Encrypt / RFC 8555; `acme-client`
  does the heavy lifting — don't hand-roll protocol steps.
- Error messages surfaced to the UI go through `friendlyError()` in
  server.js, which trims ACME problem-document noise to the detail text.
- UI is dark and compact, styled entirely with CSS variables at the top
  of `server/public/index.html`.
