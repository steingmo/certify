/*
 * DNS provider APIs for automatic DNS-01 validation.
 *
 * Each provider: { label, fields, present(cfg, fqdn, value, zone) -> handle,
 * cleanup(cfg, fqdn, value, zone, handle) }. `zone` is the DNS zone apex
 * (found via public SOA lookup, see findZone) and `fqdn` the full
 * _acme-challenge name. Fields marked `secret` are stored in the Keychain.
 */

const crypto = require('crypto');
const dns = require('dns');

const TTL = 120;

async function http(method, url, { headers = {}, body, form } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: form ? new URLSearchParams(form) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { ok: res.ok, status: res.status, data };
}

function failure(provider, action, r) {
  const d = r.data;
  const detail = typeof d === 'string' ? d
    : d && (d.errors || d.error || d.message) ? JSON.stringify(d.errors || d.error || d.message)
    : '';
  return new Error(`${provider}: ${action} failed (HTTP ${r.status}) ${detail}`.trim());
}

const relativeName = (fqdn, zone) => fqdn.slice(0, -(zone.length + 1));

const publicResolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);

/** Walks up from the name to the first label that has its own SOA: the zone apex. */
async function findZone(fqdn) {
  const labels = fqdn.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    try {
      await publicResolver.resolveSoa(candidate);
      return candidate;
    } catch { /* not a zone apex, keep walking */ }
  }
  throw new Error(`Could not find the DNS zone for ${fqdn}.`);
}

/* ------------------------------------------------------ DNS Made Easy */

function dnsMadeEasy(cfg) {
  return (method, path, body) => {
    const date = new Date().toUTCString();
    const hmac = crypto.createHmac('sha1', cfg.secretKey).update(date).digest('hex');
    return http(method, `https://api.dnsmadeeasy.com/V2.0${path}`, {
      headers: { 'x-dnsme-apiKey': cfg.apiKey, 'x-dnsme-requestDate': date, 'x-dnsme-hmac': hmac },
      body,
    });
  };
}

/* ------------------------------------------------------------ Azure */

async function azureRecordSet(cfg, fqdn, zone) {
  const token = await http('POST', `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    form: {
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://management.azure.com/.default',
    },
  });
  if (!token.ok) throw failure('Azure DNS', 'signing in', token);
  const headers = { Authorization: `Bearer ${token.data.access_token}` };
  const url = `https://management.azure.com/subscriptions/${encodeURIComponent(cfg.subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(cfg.resourceGroup)}/providers/Microsoft.Network/dnsZones/${zone}` +
    `/TXT/${relativeName(fqdn, zone)}?api-version=2018-05-01`;
  const existing = await http('GET', url, { headers });
  if (!existing.ok && existing.status !== 404) throw failure('Azure DNS', 'reading the TXT record set', existing);
  const values = existing.ok ? (existing.data.properties.TXTRecords || []).map((r) => r.value.join('')) : [];
  return { url, headers, values };
}

async function azureWrite(set, values) {
  const r = values.length
    ? await http('PUT', set.url, {
        headers: set.headers,
        body: { properties: { TTL, TXTRecords: values.map((v) => ({ value: [v] })) } },
      })
    : await http('DELETE', set.url, { headers: set.headers });
  if (!r.ok) throw failure('Azure DNS', 'updating the TXT record set', r);
}

/* -------------------------------------------------------- providers */

const providers = {
  dnsmadeeasy: {
    label: 'DNS Made Easy',
    fields: [
      { key: 'apiKey', label: 'API key' },
      { key: 'secretKey', label: 'Secret key', secret: true },
    ],
    async present(cfg, fqdn, value, zone) {
      const api = dnsMadeEasy(cfg);
      const domain = await api('GET', `/dns/managed/name?domainname=${encodeURIComponent(zone)}`);
      if (!domain.ok || !domain.data || !domain.data.id) throw failure('DNS Made Easy', `finding zone ${zone}`, domain);
      const r = await api('POST', `/dns/managed/${domain.data.id}/records`, {
        type: 'TXT', name: relativeName(fqdn, zone), value, ttl: TTL,
      });
      if (!r.ok) throw failure('DNS Made Easy', 'creating the TXT record', r);
      return { zoneId: domain.data.id, recordId: r.data.id };
    },
    async cleanup(cfg, fqdn, value, zone, handle) {
      const r = await dnsMadeEasy(cfg)('DELETE', `/dns/managed/${handle.zoneId}/records/${handle.recordId}`);
      if (!r.ok) throw failure('DNS Made Easy', 'deleting the TXT record', r);
    },
  },

  cloudflare: {
    label: 'Cloudflare',
    fields: [{ key: 'apiToken', label: 'API token (Zone · DNS · Edit)', secret: true }],
    async present(cfg, fqdn, value, zone) {
      const headers = { Authorization: `Bearer ${cfg.apiToken}` };
      const zones = await http('GET', `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zone)}`, { headers });
      if (!zones.ok) throw failure('Cloudflare', `finding zone ${zone}`, zones);
      const zoneId = zones.data.result && zones.data.result[0] && zones.data.result[0].id;
      if (!zoneId) throw new Error(`Cloudflare: zone ${zone} is not in this account.`);
      const r = await http('POST', `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
        headers, body: { type: 'TXT', name: fqdn, content: value, ttl: TTL },
      });
      if (!r.ok) throw failure('Cloudflare', 'creating the TXT record', r);
      return { zoneId, recordId: r.data.result.id };
    },
    async cleanup(cfg, fqdn, value, zone, handle) {
      const r = await http('DELETE', `https://api.cloudflare.com/client/v4/zones/${handle.zoneId}/dns_records/${handle.recordId}`, {
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      });
      if (!r.ok) throw failure('Cloudflare', 'deleting the TXT record', r);
    },
  },

  azure: {
    label: 'Azure DNS',
    hint: 'An app registration (service principal) with the DNS Zone Contributor role on the zone.',
    fields: [
      { key: 'tenantId', label: 'Tenant ID' },
      { key: 'clientId', label: 'Client (app) ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
      { key: 'subscriptionId', label: 'Subscription ID' },
      { key: 'resourceGroup', label: 'Resource group' },
    ],
    // One TXT record set holds every value at a name (wildcard + apex share
    // one), so both calls read-modify-write; callers must serialize them.
    async present(cfg, fqdn, value, zone) {
      const set = await azureRecordSet(cfg, fqdn, zone);
      if (!set.values.includes(value)) await azureWrite(set, [...set.values, value]);
      return null;
    },
    async cleanup(cfg, fqdn, value, zone) {
      const set = await azureRecordSet(cfg, fqdn, zone);
      await azureWrite(set, set.values.filter((v) => v !== value));
    },
  },
};

module.exports = { providers, findZone, publicResolver };
