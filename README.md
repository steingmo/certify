# Certify

A native macOS app for requesting Let's Encrypt certificates with DNS-01
validation — like a mini Certify The Web / Certbot with a GUI. Issues
certificates (including wildcards), saves certbot-style PEM files, exports
password-protected PFX bundles for Windows/IIS/RDS, and — with a DNS provider
connected — handles the DNS records and renews certificates automatically.

## Install

With [Homebrew](https://brew.sh):

```sh
brew install --cask steingmo/tap/certify
```

Or grab the latest notarized build from the
[Releases page](https://github.com/steingmo/certify/releases), unzip, and drag
**Certify.app** to Applications. The app is signed and notarized with a
Developer ID, so it runs without Gatekeeper warnings.

Requires macOS 13 (Ventura) or newer, Intel or Apple silicon. Nothing else to
install — the Node.js runtime is bundled inside the app.

The app checks for updates via [Sparkle](https://sparkle-project.org)
(or on demand from the app menu) and can install them in place. Homebrew
installs can also update with `brew upgrade --cask certify`.

## How it works

1. **Details** — enter domains (one per line, `*.example.com` for wildcard),
   contact email, Staging/Production, and the folder to save into.
2. **DNS validation** — the app shows the `_acme-challenge` TXT records to add
   at your DNS provider. **Check DNS** confirms they're visible (queried via
   1.1.1.1 / 8.8.8.8 to bypass local caches), then **Verify & Issue**.
3. **Issued** — PEM files are written to `<folder>/<domain>/`: `cert.pem`,
   `chain.pem`, `fullchain.pem`, `privkey.pem` (same layout as certbot).
   Enter a password and **Export PFX** to save a PKCS#12 bundle.

### DNS providers and automatic renewal

Add an account under **DNS providers** — **DNS Made Easy**, **Cloudflare**, or
**Azure DNS** — and pick it under *DNS validation* in step 1. Certify then
creates the TXT records through the provider's API, waits until every
authoritative name server serves them, issues the certificate, and deletes
the records again. API secrets are stored in your macOS Keychain.

With **Renew automatically** on, the certificate appears under
**Certificates**. A background job checks every day at 03:17 and at login —
even when the app is closed — and renews certificates with less than a third
of their lifetime left (30 days for Let's Encrypt's 90-day certificates). If
you exported a PFX with *Create the PFX on every renewal* ticked, a fresh
`.pfx` is written next to the PEM files too. You get a notification after
each renewal; the log is in `~/Library/Application Support/Certify/renew.log`.

Notes:

- The PFX uses 3DES/SHA1 for maximum compatibility (imports cleanly on
  Windows Server 2012R2–2025 without the OpenSSL 3 AES-256 problem).
- ACME account keys are stored per-environment in
  `~/Library/Application Support/Certify` and reused.
- Always test in Staging first — Production counts against Let's Encrypt
  rate limits.
- The bundled server binds to 127.0.0.1 only.

## Architecture

The app is a thin native SwiftUI shell around a local Node.js/Express server:

- `Sources/Certify/` — SwiftUI wrapper: starts the bundled Node server on a
  free localhost port, shows the UI in a WKWebView window, routes downloads
  (PFX export) to a native save dialog, stops the server on quit.
- `server/` — the Node.js server: ACME (acme-client), PEM/PFX handling
  (node-forge), and the web UI. Also runs standalone: `npm install && npm start`.
  `automation.js` holds provider issuance, renewal and the launchd schedule;
  `dns-providers.js` the provider APIs (`node test-providers.js` checks them).
- `assets/node` — universal Node.js runtime bundled into the app
  (not committed; fetched by `assets/fetch-node.sh`).

## Build from source

```sh
./build.sh          # dev build (current arch, ad-hoc signed) -> build/Certify.app
./release.sh        # universal, Developer ID signed + notarized -> build/Certify.zip
```

The scripts fetch the Node runtime and install server dependencies
automatically on first run. `release.sh` needs a Developer ID Application
certificate and a notarytool keychain profile (default name `keytype-notary`).
