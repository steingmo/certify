/*
 * Certify — a small local ACME (Let's Encrypt) certificate tool
 *
 * Flow:
 *   1. POST /api/order        -> creates ACME order, returns DNS-01 TXT records to add
 *   2. GET  /api/check-dns    -> checks the TXT records are visible in public DNS
 *   3. POST /api/issue        -> asks Let's Encrypt to validate, finalizes, writes PEM files
 *   4. POST /api/export-pfx   -> builds a password-protected PKCS#12 (.pfx) from the issued cert
 *
 * PEM files are written to <saveFolder>/<domain>/{cert,chain,fullchain,privkey}.pem
 * just like certbot, so they drop straight into Caddy/HAProxy/etc.
 */

const path = require('path');
const fs = require('fs');
const dns = require('dns');
const express = require('express');
const acme = require('acme-client');
const forge = require('node-forge');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = process.env.CERTIFY_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// In-memory store of pending orders (this is a local single-user tool)
const orders = new Map();
let orderSeq = 1;

/* ---------------------------------------------------------------- helpers */

function baseDomain(domain) {
  return domain.replace(/^\*\./, '');
}

function sanitizeFolderName(domain) {
  return baseDomain(domain).replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

async function getAccountKey(env) {
  const keyPath = path.join(DATA_DIR, `account-${env}.pem`);
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }
  const key = await acme.crypto.createPrivateRsaKey(2048);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function validateDomain(d) {
  return /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(d);
}

/* ------------------------------------------------------ 1. create order */

app.post('/api/order', async (req, res) => {
  try {
    const { domains, email, environment, saveFolder } = req.body || {};

    const list = String(domains || '')
      .split(/\r?\n/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    if (!list.length) return res.status(400).json({ error: 'Enter at least one domain.' });
    const bad = list.find((d) => !validateDomain(d));
    if (bad) return res.status(400).json({ error: `"${bad}" is not a valid domain name.` });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid contact email.' });
    }
    const env = environment === 'production' ? 'production' : 'staging';
    const folder = saveFolder && saveFolder.trim() ? path.resolve(saveFolder.trim()) : path.join(process.cwd(), 'certs');

    const accountKey = await getAccountKey(env);
    const client = new acme.Client({
      directoryUrl: acme.directory.letsencrypt[env],
      accountKey,
    });

    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: [`mailto:${email}`],
    });

    const order = await client.createOrder({
      identifiers: list.map((d) => ({ type: 'dns', value: d })),
    });

    const authorizations = await client.getAuthorizations(order);

    const records = [];
    const pending = [];
    for (const authz of authorizations) {
      const challenge = authz.challenges.find((c) => c.type === 'dns-01');
      if (!challenge) {
        return res.status(400).json({
          error: `No DNS-01 challenge offered for ${authz.identifier.value}.`,
        });
      }
      const value = await client.getChallengeKeyAuthorization(challenge);
      records.push({
        domain: (authz.wildcard ? '*.' : '') + authz.identifier.value,
        type: 'TXT',
        name: `_acme-challenge.${authz.identifier.value}`,
        value,
        status: authz.status,
      });
      pending.push({ authz, challenge });
    }

    const id = String(orderSeq++);
    orders.set(id, { client, order, pending, records, list, env, folder, email });

    res.json({ id, environment: env, saveFolder: folder, records });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

/* ------------------------------------------------------ 2. check DNS */

app.get('/api/check-dns', async (req, res) => {
  const entry = orders.get(String(req.query.id));
  if (!entry) return res.status(404).json({ error: 'Order not found. Start over.' });

  const resolver = new dns.promises.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  const results = [];
  for (const rec of entry.records) {
    let found = false;
    let seen = [];
    try {
      const txt = await resolver.resolveTxt(rec.name);
      seen = txt.map((chunks) => chunks.join(''));
      found = seen.includes(rec.value);
    } catch (e) {
      /* NXDOMAIN / no data -> not found yet */
    }
    results.push({ name: rec.name, value: rec.value, found, seen });
  }
  res.json({ results, allFound: results.every((r) => r.found) });
});

/* ------------------------------------------------------ 3. verify & issue */

app.post('/api/issue', async (req, res) => {
  const entry = orders.get(String(req.body.id));
  if (!entry) return res.status(404).json({ error: 'Order not found. Start over.' });

  try {
    const { client, order, pending, list, folder } = entry;

    // Tell the CA each pending challenge is ready, then wait for validation
    for (const { authz, challenge } of pending) {
      if (authz.status === 'valid') continue;
      await client.completeChallenge(challenge);
      await client.waitForValidStatus(challenge);
    }

    // Key + CSR for the certificate itself.
    // RSA 2048 keeps the resulting PFX importable everywhere (incl. older Windows).
    const [certKey, csr] = await acme.crypto.createCsr(
      {
        commonName: list[0],
        altNames: list,
      },
      await acme.crypto.createPrivateRsaKey(2048)
    );

    const finalized = await client.finalizeOrder(order, csr);
    const certChainPem = await client.getCertificate(finalized);

    // Split fullchain into leaf + intermediates
    const chainParts = acme.crypto.splitPemChain(certChainPem);
    const certPem = chainParts[0];
    const intermediatesPem = chainParts.slice(1).join('\n');

    const outDir = path.join(entry.folder, sanitizeFolderName(list[0]));
    fs.mkdirSync(outDir, { recursive: true });

    const files = {
      'privkey.pem': certKey.toString(),
      'cert.pem': certPem.trim() + '\n',
      'chain.pem': intermediatesPem.trim() + '\n',
      'fullchain.pem': certChainPem.trim() + '\n',
    };
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(outDir, name), content, {
        mode: name === 'privkey.pem' ? 0o600 : 0o644,
      });
    }

    entry.issued = { outDir, certKey: certKey.toString(), certChainPem };

    const info = acme.crypto.readCertificateInfo(certPem);
    res.json({
      outDir,
      files: Object.keys(files),
      notAfter: info.notAfter,
      notBefore: info.notBefore,
      domains: [info.domains.commonName, ...(info.domains.altNames || [])].filter(
        (v, i, a) => v && a.indexOf(v) === i
      ),
    });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

/* ------------------------------------------------------ 4. export PFX */

app.post('/api/export-pfx', async (req, res) => {
  const entry = orders.get(String(req.body.id));
  if (!entry || !entry.issued) {
    return res.status(404).json({ error: 'No issued certificate for this session.' });
  }
  const password = String(req.body.password || '');
  if (!password) return res.status(400).json({ error: 'Enter a password for the PFX file.' });

  try {
    const { certKey, certChainPem, outDir } = entry.issued;

    const privateKey = forge.pki.privateKeyFromPem(certKey);
    const certs = acme.crypto
      .splitPemChain(certChainPem)
      .map((p) => forge.pki.certificateFromPem(p));

    // 3DES/SHA1 for maximum import compatibility (Windows Server, RDS, IIS)
    const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, certs, password, {
      algorithm: '3des',
      friendlyName: entry.list[0],
    });
    const der = forge.asn1.toDer(p12).getBytes();
    const buf = Buffer.from(der, 'binary');

    const fileName = `${sanitizeFolderName(entry.list[0])}.pfx`;
    fs.writeFileSync(path.join(outDir, fileName), buf, { mode: 0o600 });

    res.setHeader('Content-Type', 'application/x-pkcs12');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

/* ------------------------------------------------ download issued PEMs */

app.get('/api/download', (req, res) => {
  const entry = orders.get(String(req.query.id));
  const file = String(req.query.file || '');
  if (!entry || !entry.issued) return res.status(404).send('Not found');
  if (!['cert.pem', 'chain.pem', 'fullchain.pem', 'privkey.pem'].includes(file)) {
    return res.status(400).send('Bad file');
  }
  res.download(path.join(entry.issued.outDir, file), file);
});

function friendlyError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/urn:ietf:params:acme:error/.test(msg)) {
    // Trim ACME problem-document noise down to the detail text
    const m = msg.match(/detail":\s*"([^"]+)/) || msg.match(/: (.+)$/);
    if (m) return m[1];
  }
  return msg;
}

const PORT = process.env.PORT || 8443;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Certify running at http://127.0.0.1:${PORT}`);
});
