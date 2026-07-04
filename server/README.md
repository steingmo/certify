# Certify — local ACME certificate tool

A small local web app (like a mini Certify The Web / Certbot) that requests
certificates from Let's Encrypt using **manual DNS-01 validation**, saves the
result as certbot-style PEM files, and can export a **password-protected .pfx**.

## Requirements
- Node.js 18+ (`brew install node` on macOS)

## Run
```bash
npm install
npm start
```
Then open http://127.0.0.1:8443

## Flow
1. **Details** — enter domains (one per line, `*.example.com` for wildcard),
   contact email, Staging/Production, and the folder to save into.
2. **DNS validation** — the app shows the `_acme-challenge` TXT records to add
   at your DNS provider. Use **Check DNS** to confirm they're visible
   (queried via 1.1.1.1 / 8.8.8.8 to bypass local caches), then **Verify & Issue**.
3. **Issued** — PEM files are written to `<folder>/<domain>/`:
   `cert.pem`, `chain.pem`, `fullchain.pem`, `privkey.pem` (same layout as certbot).
   Enter a password and click **Export PFX** to download a PKCS#12 bundle
   containing the key + full chain.

## Notes
- The PFX uses 3DES/SHA1 encryption for maximum compatibility (imports on
  Windows Server 2012R2–2025, RDS, IIS, RD Gateway without the OpenSSL 3
  AES-256 import problem).
- The certificate key is RSA 2048.
- ACME account keys are stored per-environment in `./data/` and reused.
- Staging issues untrusted test certificates with no rate limits — always
  test there first. Production certs count against Let's Encrypt rate limits.
- The app binds to 127.0.0.1 only.
