/*
 * Shared certificate plumbing + automation: DNS provider accounts,
 * provider-driven issuance, auto-renewal, and the launchd schedule.
 *
 * State in DATA_DIR: providers.json and certificates.json (no secrets —
 * provider secrets and remembered PFX passwords live in the Keychain).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns');
const { execFileSync } = require('child_process');
const acme = require('acme-client');
const forge = require('node-forge');
const { providers: dnsProviders, findZone, publicResolver } = require('./dns-providers');

const DATA_DIR = process.env.CERTIFY_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ basics */

const baseDomain = (domain) => domain.replace(/^\*\./, '');
const sanitizeFolderName = (domain) => baseDomain(domain).replace(/[^a-zA-Z0-9.\-_]/g, '_');

async function getAccountKey(env) {
  const keyPath = path.join(DATA_DIR, `account-${env}.pem`);
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath);
  const key = await acme.crypto.createPrivateRsaKey(2048);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function friendlyError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/urn:ietf:params:acme:error/.test(msg)) {
    // Trim ACME problem-document noise down to the detail text
    const m = msg.match(/detail":\s*"([^"]+)/) || msg.match(/: (.+)$/);
    if (m) return m[1];
  }
  return msg;
}

/** Writes certbot-style PEM files and returns what the UI shows. */
function writeCertFiles(folder, domains, certKey, certChainPem) {
  const chainParts = acme.crypto.splitPemChain(certChainPem);
  const outDir = path.join(folder, sanitizeFolderName(domains[0]));
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    'privkey.pem': certKey.toString(),
    'cert.pem': chainParts[0].trim() + '\n',
    'chain.pem': chainParts.slice(1).join('\n').trim() + '\n',
    'fullchain.pem': certChainPem.trim() + '\n',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), content, { mode: name === 'privkey.pem' ? 0o600 : 0o644 });
  }
  const info = acme.crypto.readCertificateInfo(chainParts[0]);
  return {
    outDir,
    files: Object.keys(files),
    notAfter: info.notAfter,
    notBefore: info.notBefore,
    domains: [info.domains.commonName, ...(info.domains.altNames || [])].filter((v, i, a) => v && a.indexOf(v) === i),
    certKey: certKey.toString(),
    certChainPem,
  };
}

/** Password-protected PKCS#12; 3DES/SHA1 for import on older Windows Server/RDS/IIS. */
function buildPfx(certKeyPem, certChainPem, password, friendlyName) {
  const privateKey = forge.pki.privateKeyFromPem(certKeyPem);
  const certs = acme.crypto.splitPemChain(certChainPem).map((p) => forge.pki.certificateFromPem(p));
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, certs, password, { algorithm: '3des', friendlyName });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

/* ---------------------------------------------------------- Keychain */

// Secrets go to `security` on stdin (never argv, which other processes can
// read) and base64-encoded, so no quoting can break the command line.
const KEYCHAIN_SERVICE = 'Certify';

function keychainSet(account, value) {
  const b64 = Buffer.from(JSON.stringify(value)).toString('base64');
  execFileSync('/usr/bin/security', ['-i'], {
    input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${b64}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

function keychainGet(account) {
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(Buffer.from(out.toString().trim(), 'base64').toString());
  } catch {
    return null;
  }
}

function keychainDelete(account) {
  try {
    execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { stdio: 'ignore' });
  } catch { /* already gone */ }
}

/* ------------------------------------------------------------ stores */

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return []; }
}
function writeJson(name, value) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

const listProviders = () => readJson('providers.json');
const listCertificates = () => readJson('certificates.json');

function addProvider({ type, name, values }) {
  const def = dnsProviders[type];
  if (!def) throw new Error('Unknown DNS provider.');
  const config = {};
  const secrets = {};
  for (const f of def.fields) {
    const v = String((values || {})[f.key] || '').trim();
    if (!v) throw new Error(`${f.label} is required.`);
    (f.secret ? secrets : config)[f.key] = v;
  }
  const entry = { id: crypto.randomUUID(), type, name: String(name || '').trim() || def.label, config };
  keychainSet(entry.id, secrets);
  writeJson('providers.json', [...listProviders(), entry]);
  return entry;
}

function removeProvider(id) {
  const user = listCertificates().find((c) => c.providerId === id);
  if (user) throw new Error(`Used by ${user.domains[0]} — remove that certificate first.`);
  writeJson('providers.json', listProviders().filter((p) => p.id !== id));
  keychainDelete(id);
}

function addCertificate(fields) {
  const entry = { id: crypto.randomUUID(), autoRenew: true, ...fields };
  writeJson('certificates.json', [...listCertificates(), entry]);
  syncScheduler();
  return entry;
}

function updateCertificate(id, patch) {
  writeJson('certificates.json', listCertificates().map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

function removeCertificate(id) {
  writeJson('certificates.json', listCertificates().filter((c) => c.id !== id));
  keychainDelete(`pfx-${id}`);
  syncScheduler();
}

function rememberPfxPassword(certificateId, password) {
  keychainSet(`pfx-${certificateId}`, password);
  updateCertificate(certificateId, { pfx: true });
}

/** Reads validity from the PEM on disk, so replaced files are respected. */
function certificateInfo(cert) {
  try {
    const pem = fs.readFileSync(path.join(cert.folder, sanitizeFolderName(cert.domains[0]), 'cert.pem'));
    const info = acme.crypto.readCertificateInfo(pem);
    return { notBefore: info.notBefore, notAfter: info.notAfter };
  } catch {
    return null;
  }
}

/** Renew once less than a third of the lifetime is left (30 days for 90-day certs). */
function isDue(info) {
  if (!info) return true;
  const start = new Date(info.notBefore).getTime();
  const end = new Date(info.notAfter).getTime();
  return Date.now() > start + ((end - start) * 2) / 3;
}

/* ------------------------------------------------ provider issuance */

// ponytail: one global lock around provider calls — Azure's read-modify-write
// of a shared record set needs it; per-zone locks if many parallel jobs appear.
let providerChain = Promise.resolve();
function serial(fn) {
  const run = providerChain.then(fn);
  providerChain = run.catch(() => {});
  return run;
}

/** Waits until every authoritative name server of the zone serves the TXT value. */
async function waitForTxt(fqdn, value, zone, log) {
  const nsNames = await publicResolver.resolveNs(zone);
  const ips = (await Promise.all(nsNames.map((n) => publicResolver.resolve4(n).catch(() => [])))).flat();
  if (!ips.length) throw new Error(`Could not resolve the name servers of ${zone}.`);
  log(`Waiting for ${fqdn} on ${nsNames.length} name servers…`);
  for (let attempt = 0; attempt < 60; attempt++) { // 10 minutes
    const seen = await Promise.all(ips.map(async (ip) => {
      const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
      r.setServers([ip]);
      try { return (await r.resolveTxt(fqdn)).some((chunks) => chunks.join('') === value); } catch { return false; }
    }));
    if (seen.every(Boolean)) return;
    await sleep(10_000);
  }
  throw new Error(`The TXT record ${fqdn} did not appear on all name servers within 10 minutes.`);
}

async function issueWithProvider({ domains, email, env, folder, providerId }, log = () => {}) {
  const account = listProviders().find((p) => p.id === providerId);
  if (!account) throw new Error('The DNS provider for this certificate no longer exists.');
  const provider = dnsProviders[account.type];
  const secrets = keychainGet(account.id);
  if (!secrets) throw new Error(`The API credentials for "${account.name}" are missing from the Keychain.`);
  const cfg = { ...account.config, ...secrets };

  const client = new acme.Client({ directoryUrl: acme.directory.letsencrypt[env], accountKey: await getAccountKey(env) });
  // RSA 2048 keeps the resulting PFX importable everywhere (incl. older Windows).
  const [certKey, csr] = await acme.crypto.createCsr({ commonName: domains[0], altNames: domains }, await acme.crypto.createPrivateRsaKey(2048));
  const created = new Map();

  log(`Ordering a certificate from Let's Encrypt (${env})…`);
  const chain = await client.auto({
    csr,
    email,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    skipChallengeVerification: true, // waitForTxt below checks the authoritative servers instead
    challengeCreateFn: async (authz, challenge, value) => {
      const fqdn = `_acme-challenge.${authz.identifier.value}`;
      const zone = await findZone(fqdn);
      await serial(async () => {
        log(`Adding TXT record ${fqdn} at ${account.name}…`);
        created.set(value, { zone, handle: await provider.present(cfg, fqdn, value, zone) });
      });
      await waitForTxt(fqdn, value, zone, log);
      log(`${fqdn} is live — Let's Encrypt is validating…`);
    },
    challengeRemoveFn: async (authz, challenge, value) => {
      const entry = created.get(value);
      if (!entry) return;
      const fqdn = `_acme-challenge.${authz.identifier.value}`;
      await serial(() => provider.cleanup(cfg, fqdn, value, entry.zone, entry.handle));
      log(`Removed TXT record ${fqdn}.`);
    },
  });

  const result = writeCertFiles(folder, domains, certKey, chain);
  log(`Issued — valid until ${new Date(result.notAfter).toDateString()}.`);
  return result;
}

/* ----------------------------------------------------------- renewal */

async function renewCertificate(cert, log = () => {}) {
  try {
    const result = await issueWithProvider(cert, log);
    if (cert.pfx) {
      const password = keychainGet(`pfx-${cert.id}`);
      if (password) {
        const name = `${sanitizeFolderName(cert.domains[0])}.pfx`;
        fs.writeFileSync(path.join(result.outDir, name), buildPfx(result.certKey, result.certChainPem, password, cert.domains[0]), { mode: 0o600 });
        log(`Wrote ${name}.`);
      }
    }
    updateCertificate(cert.id, { lastRun: new Date().toISOString(), lastError: null });
    return { cert, ok: true, notAfter: result.notAfter };
  } catch (err) {
    updateCertificate(cert.id, { lastRun: new Date().toISOString(), lastError: friendlyError(err) });
    return { cert, ok: false, error: friendlyError(err) };
  }
}

/** Renews every auto-renew certificate that is due; one at a time. */
async function renewDue(log = () => {}) {
  const results = [];
  for (const cert of listCertificates().filter((c) => c.autoRenew)) {
    if (!isDue(certificateInfo(cert))) continue;
    log(`Renewing ${cert.domains.join(', ')}`);
    results.push(await renewCertificate(cert, log));
  }
  return results;
}

function notify(message) {
  try {
    // argv keeps the message out of AppleScript's quoting rules
    execFileSync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Certify"', '-e', 'end run', message]);
  } catch { /* notifications are best effort */ }
}

/* ---------------------------------------------------------- schedule */

const AGENT_LABEL = 'com.steingrimosa.certify.renew';
const AGENT_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
let schedulerStatus = { installed: false, error: null };

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function agentPlist() {
  const log = path.join(DATA_DIR, 'renew.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(__dirname, 'server.js'))}</string>
    <string>--renew</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>CERTIFY_DATA_DIR</key><string>${xml(DATA_DIR)}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>17</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/**
 * Installs the daily launchd agent while any certificate auto-renews, and
 * removes it otherwise. Leaves a loaded, unchanged agent alone so a renewal
 * that is running right now is not killed.
 */
function syncScheduler() {
  const domain = `gui/${process.getuid()}`;
  const wanted = listCertificates().some((c) => c.autoRenew);
  const loaded = () => {
    try { execFileSync('/bin/launchctl', ['print', `${domain}/${AGENT_LABEL}`], { stdio: 'ignore' }); return true; } catch { return false; }
  };
  try {
    const plist = agentPlist();
    const current = fs.existsSync(AGENT_PLIST) ? fs.readFileSync(AGENT_PLIST, 'utf8') : null;
    if (wanted && current === plist && loaded()) {
      schedulerStatus = { installed: true, error: null };
      return schedulerStatus;
    }
    if (loaded()) execFileSync('/bin/launchctl', ['bootout', `${domain}/${AGENT_LABEL}`], { stdio: 'ignore' });
    if (!wanted) {
      fs.rmSync(AGENT_PLIST, { force: true });
      schedulerStatus = { installed: false, error: null };
      return schedulerStatus;
    }
    fs.mkdirSync(path.dirname(AGENT_PLIST), { recursive: true });
    fs.writeFileSync(AGENT_PLIST, plist);
    execFileSync('/bin/launchctl', ['bootstrap', domain, AGENT_PLIST], { stdio: 'ignore' });
    schedulerStatus = { installed: true, error: null };
  } catch (err) {
    schedulerStatus = { installed: false, error: `Could not install the renewal schedule: ${err.message}` };
  }
  return schedulerStatus;
}

module.exports = {
  DATA_DIR,
  dnsProviders,
  getAccountKey,
  friendlyError,
  writeCertFiles,
  buildPfx,
  sanitizeFolderName,
  listProviders,
  addProvider,
  removeProvider,
  listCertificates,
  addCertificate,
  removeCertificate,
  rememberPfxPassword,
  certificateInfo,
  issueWithProvider,
  renewCertificate,
  renewDue,
  notify,
  syncScheduler,
  getSchedulerStatus: () => schedulerStatus,
};
