# Certify

A native macOS app for requesting Let's Encrypt certificates with manual
DNS-01 validation — like a mini Certify The Web / Certbot with a GUI.
Issues certificates (including wildcards), saves certbot-style PEM files,
and exports password-protected PFX bundles for Windows/IIS/RDS.

## Download

**[Download the latest Certify.zip](https://github.com/steingmo/certify/releases/latest)** —
unzip, drag `Certify.app` to Applications, open. Signed and notarized; runs on
macOS 13+ (Intel and Apple Silicon). Nothing else to install — the Node.js
runtime is bundled inside the app.

## How it works

1. **Details** — enter domains (one per line, `*.example.com` for wildcard),
   contact email, Staging/Production, and the folder to save into.
2. **DNS validation** — the app shows the `_acme-challenge` TXT records to add
   at your DNS provider. **Check DNS** confirms they're visible (queried via
   1.1.1.1 / 8.8.8.8 to bypass local caches), then **Verify & Issue**.
3. **Issued** — PEM files are written to `<folder>/<domain>/`: `cert.pem`,
   `chain.pem`, `fullchain.pem`, `privkey.pem` (same layout as certbot).
   Enter a password and **Export PFX** to save a PKCS#12 bundle.

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
