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
 *
 * With a DNS provider configured the same happens unattended
 * (POST /api/auto-issue, see automation.js), and `node server.js --renew`
 * — run daily by a launchd agent — renews certificates that are due.
 */

const path = require('path');
const fs = require('fs');
const dns = require('dns');
const express = require('express');
const acme = require('acme-client');
const auto = require('./automation');
const { getAccountKey, friendlyError, sanitizeFolderName } = auto;

const app = express();
// Only answer requests addressed to loopback: a DNS-rebinding page could
// otherwise reach this API (and the stored DNS credentials) from a browser.
app.use((req, res, next) => (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '') ? next() : res.status(403).end()));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store of pending orders (this is a local single-user tool)
const orders = new Map();
let orderSeq = 1;

/* ---------------------------------------------------------------- helpers */

function validateDomain(d) {
  return /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(d);
}

/* ------------------------------------------------------ 1. create order */

/** Validates the Step 1 form; returns { list, email, env, folder } or throws a user-facing Error. */
function parseRequest({ domains, email, environment, saveFolder } = {}) {
  const list = String(domains || '')
    .split(/\r?\n/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) throw new Error('Enter at least one domain.');
  const bad = list.find((d) => !validateDomain(d));
  if (bad) throw new Error(`"${bad}" is not a valid domain name.`);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid contact email.');
  const env = environment === 'production' ? 'production' : 'staging';
  const folder = saveFolder && saveFolder.trim() ? path.resolve(saveFolder.trim()) : path.join(process.cwd(), 'certs');
  return { list, email, env, folder };
}

app.post('/api/order', async (req, res) => {
  let parsed;
  try { parsed = parseRequest(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const { list, email, env, folder } = parsed;

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

    // RSA 2048 keeps the resulting PFX importable everywhere (incl. older Windows).
    const [certKey, csr] = await acme.crypto.createCsr(
      { commonName: list[0], altNames: list },
      await acme.crypto.createPrivateRsaKey(2048)
    );
    const finalized = await client.finalizeOrder(order, csr);
    const issued = auto.writeCertFiles(folder, list, certKey, await client.getCertificate(finalized));
    entry.issued = issued;
    res.json(issuedResponse(issued));
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
    const buf = auto.buildPfx(certKey, certChainPem, password, entry.list[0]);
    if (req.body.remember && entry.certificateId) auto.rememberPfxPassword(entry.certificateId, password);

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


const issuedResponse = ({ outDir, files, notAfter, notBefore, domains }) => ({ outDir, files, notAfter, notBefore, domains });

/* ------------------------------------------ background jobs (polled) */

// Provider issuance takes minutes (DNS propagation), longer than a web view
// request should stay open, so it runs as a job the UI polls.
const jobs = new Map();
function startJob(work) {
  const id = String(orderSeq++);
  const job = { status: 'running', log: [], result: null, error: null };
  jobs.set(id, job);
  work((line) => job.log.push(line))
    .then((result) => Object.assign(job, { status: 'done', result }))
    .catch((err) => Object.assign(job, { status: 'error', error: friendlyError(err) }));
  return id;
}

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  job ? res.json(job) : res.status(404).json({ error: 'Job not found.' });
});

/* ------------------------------------------------- DNS provider accounts */

app.get('/api/providers', (req, res) => {
  res.json({
    types: Object.entries(auto.dnsProviders).map(([type, p]) => ({ type, label: p.label, hint: p.hint, fields: p.fields })),
    providers: auto.listProviders(), // config only — secrets stay in the Keychain
  });
});

app.post('/api/providers', (req, res) => {
  try { res.json(auto.addProvider(req.body || {})); } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/providers/:id', (req, res) => {
  try { auto.removeProvider(req.params.id); res.json({ ok: true }); } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ------------------------------------------ issue through a DNS provider */

app.post('/api/auto-issue', (req, res) => {
  let parsed;
  try { parsed = parseRequest(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
  const { list, email, env, folder } = parsed;
  const providerId = String(req.body.providerId || '');
  if (!auto.listProviders().some((p) => p.id === providerId)) return res.status(400).json({ error: 'Choose a DNS provider.' });

  const jobId = startJob(async (log) => {
    const issued = await auto.issueWithProvider({ domains: list, email, env, folder, providerId }, log);
    const cert = req.body.autoRenew
      ? auto.addCertificate({ domains: list, email, env, folder, providerId, lastRun: new Date().toISOString(), lastError: null })
      : null;
    if (cert) log('Automatic renewal is on.');
    // Register like a manual order so Step 3 downloads / PFX export work unchanged.
    const id = String(orderSeq++);
    orders.set(id, { list, env, folder, email, issued, certificateId: cert && cert.id });
    return { id, certificateId: cert && cert.id, ...issuedResponse(issued) };
  });
  res.json({ jobId });
});

/* ------------------------------------------------ managed certificates */

app.get('/api/certificates', (req, res) => {
  const providers = auto.listProviders();
  res.json({
    scheduler: auto.getSchedulerStatus(),
    certificates: auto.listCertificates().map((c) => ({
      ...c,
      provider: (providers.find((p) => p.id === c.providerId) || {}).name || 'missing provider',
      ...auto.certificateInfo(c),
    })),
  });
});

app.post('/api/certificates/:id/renew', (req, res) => {
  const cert = auto.listCertificates().find((c) => c.id === req.params.id);
  if (!cert) return res.status(404).json({ error: 'Certificate not found.' });
  res.json({
    jobId: startJob(async (log) => {
      const r = await auto.renewCertificate(cert, log);
      if (!r.ok) throw new Error(r.error);
      return r;
    }),
  });
});

app.delete('/api/certificates/:id', (req, res) => {
  auto.removeCertificate(req.params.id);
  res.json({ ok: true });
});

/* --------------------------------------------------------------- start */

if (process.argv.includes('--renew')) {
  // Run by the launchd agent: renew what's due, notify, exit.
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  auto.renewDue(log).then((results) => {
    for (const r of results) {
      const name = r.cert.domains[0];
      auto.notify(r.ok ? `Renewed ${name} — valid until ${new Date(r.notAfter).toLocaleDateString()}.` : `Renewal failed for ${name}: ${r.error}`);
      log(r.ok ? `Renewed ${name}` : `FAILED ${name}: ${r.error}`);
    }
    if (!results.length) log('Nothing due.');
    process.exit(0);
  });
} else {
  const PORT = process.env.PORT || 8443;
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Certify running at http://127.0.0.1:${PORT}`);
  });
  auto.syncScheduler();
  // If the app is killed (not quit), it can't stop us: exit once reparented.
  const parent = process.ppid;
  setInterval(() => process.ppid !== parent && process.exit(0), 5000).unref();
}
