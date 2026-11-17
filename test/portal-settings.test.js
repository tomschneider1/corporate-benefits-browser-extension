import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePortalOrigin } from '../extension/src/lib/portal.js';

const firstPortal = 'https://unternehmen-a.mitarbeiterangebote.de';
const secondPortal = 'https://unternehmen-b.mitarbeiterangebote.de';
const popupUrl = 'chrome-extension://test/src/popup/popup.html';
const shopUrl = 'https://shop.example/';

test('portal setting accepts a valid HTTPS portal or its hostname', () => {
  assert.equal(normalizePortalOrigin('  Unternehmen-A.mitarbeiterangebote.de  '), firstPortal);
  assert.equal(normalizePortalOrigin(firstPortal + '/login?from=example'), firstPortal);
  assert.equal(normalizePortalOrigin(secondPortal), secondPortal);

  for (const address of [
    '',
    'http://unternehmen-a.mitarbeiterangebote.de',
    'https://mitarbeiterangebote.de',
    'https://unternehmen-a.mitarbeiterangebote.de.example',
    'https://shop.example/unternehmen-a.mitarbeiterangebote.de',
    'https://user@unternehmen-a.mitarbeiterangebote.de',
    'https://unternehmen-a.mitarbeiterangebote.de:1234',
  ]) {
    assert.equal(normalizePortalOrigin(address), null, address);
  }
});

async function loadServiceWorker(t, seed = {}, portal = {}) {
  const local = structuredClone(seed);
  const session = {};
  const listeners = {};
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener; } });

  function area(data) {
    return {
      async get(key) {
        return structuredClone(key === null ? data : { [key]: data[key] });
      },
      async set(updates) {
        Object.assign(data, structuredClone(updates));
      },
      async remove(keys) {
        for (const key of [keys].flat()) delete data[key];
      },
    };
  }

  let account = 'test-account-1';
  const host = new URL(firstPortal).hostname;
  t.mock.method(globalThis, 'fetch', portal.fetch ?? (() => assert.fail('Unexpected portal request')));
  const browser = {
    storage: {
      local: {
        ...area(local),
        async setAccessLevel({ accessLevel }) {
          assert.equal(accessLevel, 'TRUSTED_CONTEXTS');
        },
      },
      session: area(session),
    },
    cookies: {
      async getAll({ url }) {
        return [{ domain: new URL(url).hostname, path: '/', name: 'session', value: account, storeId: '0' }];
      },
      onChanged: event('cookieChanged'),
    },
    runtime: {
      getURL: (path) => 'chrome-extension://test/' + path,
      async sendMessage({ kind, html }) {
        return { ok: true, data: portal.parsed[kind](html) };
      },
      onInstalled: event('installed'),
      onMessage: event('message'),
    },
    tabs: {
      onUpdated: event('tabUpdated'),
      onActivated: event('tabActivated'),
      async query() {
        return [];
      },
    },
    alarms: { onAlarm: event('alarm') },
  };
  globalThis.chrome = browser;
  t.after(() => { delete globalThis.chrome; });
  await import('../extension/src/background.js?test=' + encodeURIComponent(t.name));

  return {
    local,
    session,
    send(message, sender = { url: popupUrl }) {
      return new Promise((resolve) => listeners.message(message, sender, resolve));
    },
    changeAccount(nextAccount) {
      account = nextAccount;
      listeners.cookieChanged({ cookie: { domain: host }, cause: 'explicit', removed: false });
    },
  };
}

test('fresh installation waits for a portal configured through the popup', async (t) => {
  const { send } = await loadServiceWorker(t);
  const status = { type: 'getStatusForTab', url: shopUrl };
  const setup = { type: 'setPortalOrigin', address: firstPortal };
  const initial = await send(status);
  assert.equal(initial.ok, true);
  assert.equal(initial.catalogStats.portalOrigin, null);

  const fromWebsite = await send(setup, { url: shopUrl, tab: { url: shopUrl } });
  assert.equal(fromWebsite.ok, false);
  assert.equal((await send({ ...setup, address: 'https://shop.example/' })).ok, false);
  assert.deepEqual(await send(setup), { ok: true, portalOrigin: firstPortal });
  assert.equal((await send({ ...status, url: '' })).catalogStats.portalOrigin, firstPortal);
});

test('upgrade purges the old persistent coupon and offer-detail caches', async (t) => {
  const { local, send } = await loadServiceWorker(t, {
    cb_catalog_v1: { portalOrigin: firstPortal, offers: {} },
    cb_offer_details_v1: { 1: { saleOptions: [{ staticCode: 'DEMO-STATIC' }] } },
    cb_codes_v1: { '1:2': { codes: ['DEMO-OLD'] } },
    ['cb_codes_v1:' + secondPortal]: { '1:2': { codes: ['DEMO-OTHER'] } },
    ['cb_offer_details_v1:' + secondPortal]: { 1: { saleOptions: [{ staticCode: 'DEMO-OTHER' }] } },
  });
  assert.equal((await send({ type: 'getStatusForTab', url: '' })).catalogStats.portalOrigin, firstPortal);
  assert.deepEqual(Object.keys(local).sort(), ['cb_catalog_v1', 'cb_coupon_cache_migration_v1']);
});

const fixtures = {
  categories: () => [{ id: '1', name: 'Beispiele', path: '/overview/1' }],
  offerList: () => [{ id: '42', name: 'Shop Beispiel', path: '/offer/42' }],
  offer: () => ({
    id: '42',
    title: 'Shop Beispiel',
    saleOptions: [
      {
        soId: '2',
        type: 'code',
        title: 'Online',
        shopUrl,
        codeRequest: { url: '/api/coupon?ac=1000000000' },
      },
      { soId: '3', type: 'code', title: 'Inline', staticCode: 'DEMO-INLINE' },
    ],
  }),
};

test('shop matching and local search never query the portal search endpoint automatically', async (t) => {
  const requests = [];
  const { send } = await loadServiceWorker(t, {}, {
    async fetch(address, options) {
      const url = new URL(address);
      requests.push({ path: url.pathname, body: options.body });
      return new Response('<html></html>');
    },
    parsed: fixtures,
  });
  await send({ type: 'setPortalOrigin', address: firstPortal });
  await send({ type: 'syncCatalog', portalOrigin: firstPortal, force: true });
  requests.length = 0;

  const content = { url: 'https://unmatched.example', tab: { url: 'https://unmatched.example' } };
  assert.deepEqual((await send({ type: 'getStatusForTab' }, content)).offers, []);
  assert.deepEqual((await send({ type: 'searchCatalog', portalOrigin: firstPortal, query: 'missing' })).results, []);
  assert.equal((await send({ type: 'searchPortal', portalOrigin: firstPortal, query: 'missing' }, content)).ok, false);
  assert.deepEqual(requests, []);

  assert.equal((await send({ type: 'searchPortal', portalOrigin: firstPortal, query: 'missing' })).ok, true);
  assert.deepEqual(requests, [{ path: '/api/search', body: JSON.stringify({ search: 'missing' }) }]);
});

test('codes appear only in the popup and are cleared when the portal or account changes', async (t) => {
  const posts = [];
  const { send, changeAccount, local, session } = await loadServiceWorker(t, {}, {
    async fetch(address, options) {
      const url = new URL(address);
      assert.equal(options.credentials, 'include');
      if (url.pathname === '/api/coupon') {
        posts.push(url.origin);
        return Response.json({ success: true, code: ['DEMO-' + posts.length] });
      }
      return new Response('<html></html>');
    },
    parsed: fixtures,
  });

  await send({ type: 'setPortalOrigin', address: firstPortal });
  assert.equal((await send({ type: 'syncCatalog', portalOrigin: firstPortal, force: true })).offerCount, 1);
  const request = { type: 'requestCode', portalOrigin: firstPortal, offerId: '42', saleOptionId: '2' };
  const firstCode = await send(request);
  assert.deepEqual(firstCode.codes, ['DEMO-1']);
  assert.equal((await send(request)).cached, true);
  assert.equal((await send({ ...request, saleOptionId: '3' })).codes[0], 'DEMO-INLINE');
  assert.doesNotMatch(JSON.stringify(local), /DEMO-INLINE|DEMO-1/);
  assert.doesNotMatch(JSON.stringify(session), /test-account-1/);

  const shopMessage = { type: 'getStatusForTab', url: shopUrl };
  const content = { url: shopUrl, tab: { url: shopUrl } };
  const banner = await send(shopMessage, content);
  assert.equal(banner.offers.length, 1);
  assert.equal('codesCache' in banner, false);
  assert.deepEqual(banner.offers[0].saleOptions[0], { soId: '2', title: 'Online', type: 'code' });
  assert.equal((await send(request, content)).ok, false);

  changeAccount('test-account-2');
  const afterChange = await send(shopMessage);
  assert.deepEqual(afterChange.codesCache, {});
  assert.notEqual(afterChange.codeSessionId, firstCode.codeSessionId);
  assert.equal((await send({ ...request, codeSessionId: firstCode.codeSessionId })).ok, false);
  assert.deepEqual((await send(request)).codes, ['DEMO-2']);

  await send({ type: 'setPortalOrigin', address: secondPortal });
  assert.equal((await send({ type: 'syncCatalog', portalOrigin: secondPortal, force: true })).offerCount, 1);
  assert.deepEqual((await send({ ...request, portalOrigin: secondPortal })).codes, ['DEMO-3']);
  await send({ type: 'setPortalOrigin', address: firstPortal });
  assert.deepEqual((await send(shopMessage)).codesCache, {});
  assert.deepEqual(posts, [firstPortal, firstPortal, secondPortal]);
});

test('a coupon response arriving after an account switch is discarded', async (t) => {
  const posted = Promise.withResolvers();
  const respond = Promise.withResolvers();
  const { send, changeAccount, session } = await loadServiceWorker(t, {}, {
    async fetch(address) {
      if (new URL(address).pathname === '/api/coupon') {
        posted.resolve();
        await respond.promise;
        return Response.json({ success: true, code: ['DEMO-STALE-RESPONSE'] });
      }
      return new Response('<html></html>');
    },
    parsed: fixtures,
  });
  await send({ type: 'setPortalOrigin', address: firstPortal });
  const response = send({ type: 'requestCode', portalOrigin: firstPortal, offerId: '42', saleOptionId: '2' });
  await posted.promise;
  changeAccount('test-account-2');
  respond.resolve();

  assert.equal((await response).ok, false);
  assert.doesNotMatch(JSON.stringify(session), /DEMO-STALE-RESPONSE/);
});
