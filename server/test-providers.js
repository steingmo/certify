// Checks the DNS provider request shapes against a mocked fetch: node test-providers.js
const assert = require('assert');
const crypto = require('crypto');
const { providers } = require('./dns-providers');

let calls = [];
let respond = () => ({});
global.fetch = async (url, opts = {}) => {
  const call = { url, method: opts.method, headers: opts.headers || {}, body: opts.body };
  calls.push(call);
  const { status = 200, json = {} } = respond(call) || {};
  return { ok: status < 300, status, text: async () => JSON.stringify(json) };
};
const body = (c) => JSON.parse(c.body);

(async () => {
  const fqdn = '_acme-challenge.ad.office.fo';
  const zone = 'office.fo';

  /* DNS Made Easy */
  calls = [];
  respond = (c) => (c.method === 'GET' ? { json: { id: 42, name: zone } } : { json: { id: 7 } });
  const dme = { apiKey: 'key', secretKey: 'secret' };
  const h = await providers.dnsmadeeasy.present(dme, fqdn, 'tok', zone);
  assert.deepStrictEqual(h, { zoneId: 42, recordId: 7 });
  assert.strictEqual(calls[0].url, 'https://api.dnsmadeeasy.com/V2.0/dns/managed/name?domainname=office.fo');
  const hd = calls[1].headers;
  assert.strictEqual(hd['x-dnsme-apiKey'], 'key');
  assert.strictEqual(hd['x-dnsme-hmac'], crypto.createHmac('sha1', 'secret').update(hd['x-dnsme-requestDate']).digest('hex'));
  assert.ok(!Number.isNaN(Date.parse(hd['x-dnsme-requestDate'])));
  assert.strictEqual(calls[1].url, 'https://api.dnsmadeeasy.com/V2.0/dns/managed/42/records');
  assert.deepStrictEqual(body(calls[1]), { type: 'TXT', name: '_acme-challenge.ad', value: 'tok', ttl: 120 });
  calls = [];
  await providers.dnsmadeeasy.cleanup(dme, fqdn, 'tok', zone, h);
  assert.strictEqual(calls[0].method, 'DELETE');
  assert.strictEqual(calls[0].url, 'https://api.dnsmadeeasy.com/V2.0/dns/managed/42/records/7');

  /* Cloudflare */
  calls = [];
  respond = (c) => (c.method === 'GET' ? { json: { result: [{ id: 'z1' }] } } : { json: { result: { id: 'r1' } } });
  const cf = await providers.cloudflare.present({ apiToken: 't' }, fqdn, 'tok', zone);
  assert.deepStrictEqual(cf, { zoneId: 'z1', recordId: 'r1' });
  assert.strictEqual(calls[0].url, 'https://api.cloudflare.com/client/v4/zones?name=office.fo');
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer t');
  assert.deepStrictEqual(body(calls[1]), { type: 'TXT', name: fqdn, content: 'tok', ttl: 120 });
  respond = () => ({ json: { result: [] } });
  await assert.rejects(providers.cloudflare.present({ apiToken: 't' }, fqdn, 'tok', zone), /not in this account/);

  /* Azure: values at one name share a record set — others must survive */
  const az = { tenantId: 'ten', clientId: 'cid', clientSecret: 'sec', subscriptionId: 'sub', resourceGroup: 'rg' };
  let stored = ['other'];
  respond = (c) => {
    if (c.url.startsWith('https://login.microsoftonline.com/')) return { json: { access_token: 'AT' } };
    if (c.method === 'GET') return stored.length ? { json: { properties: { TXTRecords: stored.map((v) => ({ value: [v] })) } } } : { status: 404 };
    if (c.method === 'PUT') stored = body(c).properties.TXTRecords.map((r) => r.value.join(''));
    if (c.method === 'DELETE') stored = [];
    return {};
  };
  calls = [];
  await providers.azure.present(az, fqdn, 'tok', zone);
  assert.deepStrictEqual(stored, ['other', 'tok']);
  assert.strictEqual(calls[0].body.get('client_secret'), 'sec');
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer AT');
  assert.strictEqual(calls[1].url, 'https://management.azure.com/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/dnsZones/office.fo/TXT/_acme-challenge.ad?api-version=2018-05-01');
  await providers.azure.cleanup(az, fqdn, 'tok', zone);
  assert.deepStrictEqual(stored, ['other']);
  await providers.azure.cleanup(az, fqdn, 'other', zone);
  assert.strictEqual(calls.at(-1).method, 'DELETE');

  /* HTTP errors surface the provider and action */
  respond = () => ({ status: 403, json: { error: 'bad key' } });
  await assert.rejects(providers.dnsmadeeasy.present(dme, fqdn, 'tok', zone), /DNS Made Easy: finding zone office.fo failed \(HTTP 403\)/);

  console.log('dns providers: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
