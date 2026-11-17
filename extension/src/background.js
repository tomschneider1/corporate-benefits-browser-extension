// Background service worker (Manifest V3).
// Responsibilities:
// 1. Sync the Corporate Benefits offer catalogue (without requesting any codes!).
// 2. Match the active tab's domain against the local catalogue & lazily resolve
//    the real shop domain from the offer detail page (or `/api/search` fallback),
//    caching positive and negative results in `chrome.storage.local`.
// 3. Update the extension action badge and notify the content script to show a
//    subtle notification banner on matching shops.
// 4. Fetch coupon codes on demand when the user explicitly clicks "Code abrufen".

import {
  brandToken,
  hostnameOf,
  nameMatchesToken,
  normalize,
  registrableDomain,
} from './lib/domain.js';
import {
  SessionExpiredError,
  fetchCategories,
  fetchCategoryOffers,
  fetchOfferDetail,
  normalizePortalOrigin,
  requestCouponCode,
  searchPortalOffers,
} from './lib/portal.js';
import {
  clearCouponSession,
  getCouponSession,
  refreshCouponSession,
  rememberCouponCodes,
} from './lib/coupon-session.js';

const STORAGE_KEYS = {
  CATALOG: 'cb_catalog_v1', // { updatedAt, portalOrigin, offers: { [id]: OfferSummary } }
  OFFER_DETAILS: 'cb_offer_details_v1', // { [id]: OfferDetail & { domains: string[], fetchedAt } }
  DOMAIN_INDEX: 'cb_domain_index_v1', // { [registrableDomain]: { offerIds: string[], checkedAt: number } }
  SESSION_STATE: 'cb_session_state_v1', // { loggedIn: boolean, checkedAt: number, lastError?: string }
  DISMISSED_HOSTS: 'cb_dismissed_hosts_v1', // { [registrableDomain]: number }
};

const PORTAL_ORIGIN_KEY = 'cb_portal_origin';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NEGATIVE_DOMAIN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const ALARM_SYNC = 'cb-periodic-catalog-sync';

// Hosts where we should never attempt shop matching.
const IGNORED_DOMAINS = new Set([
  'mitarbeiterangebote.de',
  'corporate-benefits.de',
  'google.com',
  'google.de',
  'bing.com',
  'duckduckgo.com',
  'youtube.com',
  'github.com',
  'localhost',
  '127.0.0.1',
]);

const syncInFlight = new Map();
let legacyPortalOrigin;
const domainResolutionInFlight = new Map();
const couponRequests = new Map();
const storageReady = prepareLocalStorage();

async function prepareLocalStorage() {
  const storage = chrome.storage.local;
  await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

  // Older versions stored personal codes and raw offer details in local storage.
  const migrationKey = 'cb_coupon_cache_migration_v1';
  if ((await storage.get(migrationKey))[migrationKey]) return;
  const keys = Object.keys(await storage.get(null));
  const obsolete = keys.filter((key) =>
    ['cb_codes_v1', STORAGE_KEYS.OFFER_DETAILS].includes(key.split(':', 1)[0]),
  );
  if (obsolete.length) await storage.remove(obsolete);
  await storage.set({ [migrationKey]: true });
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getLegacyPortalOrigin() {
  // The catalog recorded which portal owned the unscoped v2 cache.
  legacyPortalOrigin ??= chrome.storage.local.get(STORAGE_KEYS.CATALOG)
    .then((data) => normalizePortalOrigin(data[STORAGE_KEYS.CATALOG]?.portalOrigin))
    .catch((error) => {
      legacyPortalOrigin = undefined;
      throw error;
    });
  return legacyPortalOrigin;
}

async function getPortalOrigin() {
  await storageReady;
  const data = await chrome.storage.local.get(PORTAL_ORIGIN_KEY);
  return normalizePortalOrigin(data[PORTAL_ORIGIN_KEY]) || await getLegacyPortalOrigin();
}

async function scopedKey(portalOrigin, key) {
  return portalOrigin === await getLegacyPortalOrigin() ? key : `${key}:${portalOrigin}`;
}

async function getStore(portalOrigin, key, fallback) {
  if (!portalOrigin) return fallback;
  const storageKey = await scopedKey(portalOrigin, key);
  const data = await chrome.storage.local.get(storageKey);
  return data[storageKey] ?? fallback;
}

async function setStore(portalOrigin, key, value) {
  const storageKey = await scopedKey(portalOrigin, key);
  await chrome.storage.local.set({ [storageKey]: value });
}

async function updateSessionState(portalOrigin, loggedIn, lastError = null) {
  const state = { loggedIn, checkedAt: Date.now(), lastError };
  if (!loggedIn) await clearCouponSession(portalOrigin);
  await setStore(portalOrigin, STORAGE_KEYS.SESSION_STATE, state);
  return state;
}

// ---------------------------------------------------------------------------
// Catalogue sync (categories -> offer summaries)
// ---------------------------------------------------------------------------

async function syncCatalog(portalOrigin, { force = false } = {}) {
  if (syncInFlight.has(portalOrigin)) return syncInFlight.get(portalOrigin);

  const task = (async () => {
    const existing = await getStore(portalOrigin, STORAGE_KEYS.CATALOG, null);
    if (
      !force &&
      existing?.updatedAt &&
      Date.now() - existing.updatedAt < CATALOG_TTL_MS &&
      Object.keys(existing.offers || {}).length > 0
    ) {
      return {
        status: 'cached',
        offerCount: Object.keys(existing.offers).length,
        updatedAt: existing.updatedAt,
      };
    }

    try {
      const categories = await fetchCategories(portalOrigin);
      if (!categories.length) {
        throw new Error('Keine Kategorien auf der Startseite gefunden.');
      }

      const offers = {};
      for (const cat of categories) {
        const list = await fetchCategoryOffers(cat.path, portalOrigin);
        for (const item of list) {
          offers[item.id] = {
            ...item,
            categoryId: cat.id,
            categoryName: cat.name,
          };
        }
        // Gentle pause between category requests
        await new Promise((r) => setTimeout(r, 120));
      }

      const catalog = {
        updatedAt: Date.now(),
        portalOrigin,
        categories,
        offers,
      };
      await setStore(portalOrigin, STORAGE_KEYS.CATALOG, catalog);
      await updateSessionState(portalOrigin, true, null);

      return {
        status: 'synced',
        offerCount: Object.keys(offers).length,
        categoryCount: categories.length,
        updatedAt: catalog.updatedAt,
      };
    } catch (err) {
      if (err instanceof SessionExpiredError || err?.code === 'session_expired') {
        await updateSessionState(portalOrigin, false, err.message);
      }
      throw err;
    }
  })().finally(() => syncInFlight.delete(portalOrigin));

  syncInFlight.set(portalOrigin, task);
  return task;
}

// ---------------------------------------------------------------------------
// Offer detail loading + shop domain extraction
// ---------------------------------------------------------------------------

function extractDomainsFromDetail(detail) {
  const domains = new Set();
  for (const so of detail.saleOptions || []) {
    if (so.shopUrl) {
      const host = hostnameOf(so.shopUrl);
      const rd = registrableDomain(host);
      if (rd && !IGNORED_DOMAINS.has(rd)) {
        domains.add(rd);
      }
    }
  }
  return [...domains];
}

async function getOrFetchOfferDetail(portalOrigin, offerId, offerPathHint = null) {
  const detailsMap = await getStore(portalOrigin, STORAGE_KEYS.OFFER_DETAILS, {});
  const cached = detailsMap[offerId];
  if (cached && Date.now() - (cached.fetchedAt || 0) < CATALOG_TTL_MS) {
    return cached;
  }

  const catalog = await getStore(portalOrigin, STORAGE_KEYS.CATALOG, null);
  const summary = catalog?.offers?.[offerId];
  const path = offerPathHint || summary?.path || `/offer/${offerId}`;

  try {
    const parsed = await fetchOfferDetail(path, offerId, portalOrigin);
    const domains = extractDomainsFromDetail(parsed);
    const record = {
      ...parsed,
      saleOptions: parsed.saleOptions.map(({ staticCode, ...option }) => ({
        ...option,
        hasStaticCode: Boolean(staticCode),
      })),
      path,
      name: summary?.name || parsed.title,
      teaser: summary?.teaser || parsed.claim,
      discount: parsed.discount || summary?.discount || '',
      domains,
      fetchedAt: Date.now(),
    };

    detailsMap[offerId] = record;
    await setStore(portalOrigin, STORAGE_KEYS.OFFER_DETAILS, detailsMap);

    // Also register discovered shop domains in the domain index.
    if (domains.length > 0) {
      const domainIndex = await getStore(portalOrigin, STORAGE_KEYS.DOMAIN_INDEX, {});
      for (const d of domains) {
        const prev = domainIndex[d]?.offerIds || [];
        const merged = [...new Set([...prev, String(offerId)])];
        domainIndex[d] = { offerIds: merged, checkedAt: Date.now() };
      }
      await setStore(portalOrigin, STORAGE_KEYS.DOMAIN_INDEX, domainIndex);
    }

    await updateSessionState(portalOrigin, true, null);
    return record;
  } catch (err) {
    if (err instanceof SessionExpiredError || err?.code === 'session_expired') {
      await updateSessionState(portalOrigin, false, err.message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Domain -> Offer matching
// ---------------------------------------------------------------------------

/**
 * Given a visited URL, return matching Corporate Benefits offers (with full
 * detail & saleOptions) if any exist.
 */
async function resolveOffersForUrl(portalOrigin, url) {
  const host = hostnameOf(url);
  const domain = registrableDomain(host);
  if (!portalOrigin || !domain || IGNORED_DOMAINS.has(domain)) {
    return { domain: '', offers: [], sessionState: await getStore(portalOrigin, STORAGE_KEYS.SESSION_STATE, null) };
  }

  // Deduplicate concurrent checks for the same domain within this portal.
  const lookup = `${portalOrigin}:${domain}`;
  if (domainResolutionInFlight.has(lookup)) {
    return domainResolutionInFlight.get(lookup);
  }

  const task = (async () => {
    try {
      return await resolveOffersForDomainInternal(portalOrigin, domain);
    } finally {
      domainResolutionInFlight.delete(lookup);
    }
  })();

  domainResolutionInFlight.set(lookup, task);
  return task;
}

async function resolveOffersForDomainInternal(portalOrigin, domain) {
  let catalog = await getStore(portalOrigin, STORAGE_KEYS.CATALOG, null);

  // Trigger initial background sync if catalogue is completely empty.
  if (!catalog || !catalog.offers || Object.keys(catalog.offers).length === 0) {
    try {
      await syncCatalog(portalOrigin);
      catalog = await getStore(portalOrigin, STORAGE_KEYS.CATALOG, null);
    } catch {
      // Session might be expired; continue with whatever we have.
    }
  }

  const domainIndex = await getStore(portalOrigin, STORAGE_KEYS.DOMAIN_INDEX, {});
  const indexEntry = domainIndex[domain];

  // 1. Fast path: domain was already resolved recently.
  if (indexEntry) {
    if (indexEntry.offerIds.length > 0) {
      const offers = [];
      for (const id of indexEntry.offerIds) {
        try {
          const detail = await getOrFetchOfferDetail(portalOrigin, id);
          if (detail) offers.push(detail);
        } catch {
          // Ignore individual fetch errors if cached detail exists.
        }
      }
      const token = brandToken(domain);
      offers.sort((a, b) => {
        const score = (o) => {
          let s = 0;
          if ((o.domains || []).includes(domain)) s += 100;
          if ((o.saleOptions || []).some((so) => so.type === 'code')) s += 50;
          if (normalize(o.name || o.title) === token) s += 25;
          return s;
        };
        return score(b) - score(a);
      });
      return {
        domain,
        offers,
        sessionState: await getStore(portalOrigin, STORAGE_KEYS.SESSION_STATE, null),
      };
    }
    // Negative cache hit
    if (Date.now() - (indexEntry.checkedAt || 0) < NEGATIVE_DOMAIN_TTL_MS) {
      return {
        domain,
        offers: [],
        sessionState: await getStore(portalOrigin, STORAGE_KEYS.SESSION_STATE, null),
      };
    }
  }

  // 2. Candidate search in local catalogue by brand token.
  const token = brandToken(domain);
  const candidateMap = new Map();

  if (catalog?.offers && token.length >= 2) {
    for (const offer of Object.values(catalog.offers)) {
      if (nameMatchesToken(offer.name, token)) {
        candidateMap.set(String(offer.id), offer);
      }
    }
  }

  // 3. Verify up to 4 candidates by loading their offer detail page and checking
  //    whether `shopUrl` matches `domain` (or whether the offer title is an exact
  //    brand match for partner redirect shops like spectrum8 / mitarbeiterautohaus).
  const matchedOffers = [];
  const candidates = [...candidateMap.values()].slice(0, 4);

  for (const cand of candidates) {
    try {
      const detail = await getOrFetchOfferDetail(portalOrigin, cand.id, cand.path);
      const exactDomainMatch = (detail.domains || []).includes(domain);
      const firstTitleWord = normalize((detail.name || detail.title || '').split(/[\s\-–|:,/]+/)[0]);
      const brandFallbackMatch =
        token.length >= 4 && firstTitleWord === token && (detail.saleOptions || []).some((s) => s.type !== 'info');

      if (exactDomainMatch || brandFallbackMatch) {
        matchedOffers.push({ detail, exactDomainMatch });
      }
    } catch {
      // If session expired, stop probing candidates and don't negative-cache.
      const sessionState = await getStore(portalOrigin, STORAGE_KEYS.SESSION_STATE, null);
      if (sessionState && sessionState.loggedIn === false) {
        return { domain, offers: [], sessionState };
      }
    }
  }

  // Rank offers so exact domain matches with direct coupon codes come first
  // (e.g. "adidas" with 20% code before "adidas Geschenkgutscheine" on vouchers-at-work.com).
  matchedOffers.sort((a, b) => {
    const score = (entry) => {
      let s = 0;
      if (entry.exactDomainMatch) s += 100;
      if ((entry.detail.saleOptions || []).some((so) => so.type === 'code')) s += 50;
      if (normalize(entry.detail.name || entry.detail.title) === token) s += 25;
      return s;
    };
    return score(b) - score(a);
  });

  const sortedOffers = matchedOffers.map((m) => m.detail);

  // Record in domain index (both hits and negative results).
  const updatedIndex = await getStore(portalOrigin, STORAGE_KEYS.DOMAIN_INDEX, {});
  updatedIndex[domain] = {
    offerIds: sortedOffers.map((o) => String(o.id)),
    checkedAt: Date.now(),
  };
  await setStore(portalOrigin, STORAGE_KEYS.DOMAIN_INDEX, updatedIndex);

  return {
    domain,
    offers: sortedOffers,
    sessionState: await getStore(portalOrigin, STORAGE_KEYS.SESSION_STATE, null),
  };
}

// ---------------------------------------------------------------------------
// Badge & tab lifecycle
// ---------------------------------------------------------------------------

async function updateTabBadge(tabId, url) {
  if (!tabId || !url || !url.startsWith('http')) {
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }

  const portalOrigin = await getPortalOrigin();
  const { offers } = await resolveOffersForUrl(portalOrigin, url);
  if (portalOrigin !== await getPortalOrigin()) return;
  if (offers.length > 0) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' }).catch(() => {});
    await chrome.action
      .setBadgeText({ tabId, text: String(offers.length) })
      .catch(() => {});
  } else {
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const origin = normalizePortalOrigin(changeInfo.url);
    if (origin && /^\/(?:login|logout)(?:\/|$)/i.test(new URL(changeInfo.url).pathname)) {
      clearCouponSession(origin).catch(() => {});
    }
  }
  if (changeInfo.status === 'complete' && tab?.url) {
    updateTabBadge(tabId, tab.url).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) await updateTabBadge(tabId, tab.url);
  } catch {
    // Tab may have closed.
  }
});

async function syncConfiguredPortal() {
  const portalOrigin = await getPortalOrigin();
  if (portalOrigin) await syncCatalog(portalOrigin);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_SYNC, { periodInMinutes: 60 * 12 });
  syncConfiguredPortal().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_SYNC) {
    syncConfiguredPortal().catch(() => {});
  }
});

chrome.cookies.onChanged.addListener(({ cause, cookie, removed }) => {
  // Chrome emits a removal followed by an insertion for an overwrite.
  if (removed && cause === 'overwrite') return;
  const domain = cookie.domain.replace(/^\./, '');
  getPortalOrigin().then((origin) => {
    if (!origin) return;
    const host = new URL(origin).hostname;
    if (host === domain || host.endsWith(`.${domain}`)) return refreshCouponSession(origin);
  }).catch(() => {});
});

function bannerOffers(offers) {
  return offers.map(({ id, name, title, teaser, discount, saleOptions }) => ({
    id, name, title, teaser, discount,
    saleOptions: saleOptions.map(({ soId, title, type }) => ({ soId, title, type })),
  }));
}

async function popupCodes(portalOrigin, offers) {
  if (!portalOrigin || !offers.length) return {};
  const session = await getCouponSession(portalOrigin);
  const codesCache = {};
  for (const offer of offers) {
    for (const option of offer.saleOptions) {
      const key = `${offer.id}:${option.soId}`;
      if (session.codes[key]) codesCache[key] = session.codes[key];
    }
  }
  return { codesCache, codeSessionId: session.id };
}

async function fetchCouponForPopup(portalOrigin, sessionId, offerId, saleOptionId, key) {
  try {
    const detail = await getOrFetchOfferDetail(portalOrigin, offerId);
    let option = detail.saleOptions.find((item) => String(item.soId) === String(saleOptionId));
    if (option?.hasStaticCode) {
      // Read inline codes from the current authenticated response only.
      const fresh = await fetchOfferDetail(detail.path, offerId, portalOrigin);
      option = fresh.saleOptions.find((item) => String(item.soId) === String(saleOptionId));
    }
    if (portalOrigin !== await getPortalOrigin() || (await getCouponSession(portalOrigin)).id !== sessionId) {
      throw new Error('Die Portalsitzung hat sich geändert. Versuche es erneut.');
    }

    let codes;
    if (option?.staticCode) {
      codes = [option.staticCode];
    } else if (option?.codeRequest) {
      codes = await requestCouponCode({ url: option.codeRequest.url, offerId, saleOptionId }, portalOrigin);
    } else {
      throw new Error('Für dieses Angebot ist kein Gutscheinabruf verfügbar.');
    }
    if (!await rememberCouponCodes(portalOrigin, sessionId, key, codes)) {
      throw new Error('Die Portalsitzung hat sich geändert. Versuche es erneut.');
    }

    await updateSessionState(portalOrigin, true, null);
    return codes;
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      await updateSessionState(portalOrigin, false, error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Message API for Popup & Content Script
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;

  (async () => {
    const portalOrigin = await getPortalOrigin();
    const isPopup = sender?.url === chrome.runtime.getURL('src/popup/popup.html');
    if (msg.type === 'setPortalOrigin') {
      if (!isPopup) {
        throw new Error('Das Unternehmensportal kann nur im Erweiterungsmenü geändert werden.');
      }
      const nextOrigin = normalizePortalOrigin(msg.address);
      if (!nextOrigin) {
        throw new Error('Gib eine HTTPS-Adresse unter <unternehmen>.mitarbeiterangebote.de ein.');
      }
      if (nextOrigin !== portalOrigin) {
        await clearCouponSession(portalOrigin);
        await chrome.storage.local.set({ [PORTAL_ORIGIN_KEY]: nextOrigin });
        const tabs = await chrome.tabs.query({}).catch(() => []);
        await Promise.allSettled(tabs.flatMap(({ id }) => [
          chrome.action.setBadgeText({ tabId: id, text: '' }),
          chrome.tabs.sendMessage(id, { type: 'portalChanged' }, { frameId: 0 }),
        ]));
      }
      sendResponse({ ok: true, portalOrigin: nextOrigin });
      return;
    }

    if (msg.type !== 'getStatusForTab' && (!portalOrigin || msg.portalOrigin !== portalOrigin)) {
      throw new Error('Öffne die Erweiterung erneut oder lade den Shop-Tab neu.');
    }
    if (!isPopup && ['searchCatalog', 'searchPortal', 'getOfferDetail', 'syncCatalog', 'requestCode', 'openShopLink'].includes(msg.type)) {
      throw new Error('Diese Aktion ist nur im Erweiterungsmenü verfügbar.');
    }

    switch (msg.type) {
      case 'getStatusForTab': {
        const url = (isPopup ? msg.url : sender?.tab?.url) || '';
        const { domain, offers, sessionState } = await resolveOffersForUrl(portalOrigin, url);
        const catalog = await getStore(portalOrigin, STORAGE_KEYS.CATALOG, null);
        const dismissed = await getStore(portalOrigin, STORAGE_KEYS.DISMISSED_HOSTS, {});
        const isDismissed =
          Boolean(domain && dismissed[domain]) &&
          Date.now() - dismissed[domain] < 24 * 60 * 60 * 1000;

        const couponState = isPopup ? await popupCodes(portalOrigin, offers) : null;
        if (portalOrigin !== await getPortalOrigin()) {
          throw new Error('Das Unternehmensportal wurde geändert. Lade den Tab neu.');
        }
        sendResponse({
          ok: true,
          domain,
          offers: isPopup ? offers : bannerOffers(offers),
          ...(isPopup ? couponState : {}),
          isDismissed,
          sessionState: sessionState || { loggedIn: null },
          catalogStats: {
            offerCount: Object.keys(catalog?.offers || {}).length,
            updatedAt: catalog?.updatedAt || null,
            portalOrigin,
          },
        });
        break;
      }

      case 'dismissBannerForDomain': {
        const dismissed = await getStore(portalOrigin, STORAGE_KEYS.DISMISSED_HOSTS, {});
        if (msg.domain) {
          dismissed[msg.domain] = Date.now();
          await setStore(portalOrigin, STORAGE_KEYS.DISMISSED_HOSTS, dismissed);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'syncCatalog': {
        const result = await syncCatalog(portalOrigin, { force: Boolean(msg.force) });
        // Clear negative domain cache on manual sync so newly added offers match immediately.
        if (msg.force) {
          const domainIndex = await getStore(portalOrigin, STORAGE_KEYS.DOMAIN_INDEX, {});
          for (const [d, entry] of Object.entries(domainIndex)) {
            if (!entry.offerIds || entry.offerIds.length === 0) {
              delete domainIndex[d];
            }
          }
          await setStore(portalOrigin, STORAGE_KEYS.DOMAIN_INDEX, domainIndex);
        }
        sendResponse({ ok: true, ...result });
        break;
      }

      case 'requestCode': {
        const { offerId, saleOptionId } = msg;
        const session = await getCouponSession(portalOrigin);
        if (msg.codeSessionId && msg.codeSessionId !== session.id) {
          throw new Error('Die Portalsitzung hat sich geändert. Versuche es erneut.');
        }
        const key = `${offerId}:${saleOptionId}`;
        if (session.codes[key]?.length) {
          sendResponse({ ok: true, codes: session.codes[key], codeSessionId: session.id, cached: true });
          break;
        }

        const requestKey = `${session.id}:${key}`;
        if (!couponRequests.has(requestKey)) {
          const task = fetchCouponForPopup(portalOrigin, session.id, offerId, saleOptionId, key)
            .finally(() => couponRequests.delete(requestKey));
          couponRequests.set(requestKey, task);
        }
        const codes = await couponRequests.get(requestKey);
        sendResponse({ ok: true, codes, codeSessionId: session.id, cached: false });
        break;
      }

      case 'openBannerLink': {
        const { offers } = await resolveOffersForUrl(portalOrigin, sender?.tab?.url || '');
        const offer = offers.find(({ id }) => id === msg.offerId);
        const option = offer?.saleOptions.find(({ soId }) => soId === msg.saleOptionId);
        let url;
        if (option?.type === 'link') url = option.shopUrl;
        if (option?.type === 'pdf' && option.downloadPath) url = portalOrigin + option.downloadPath;
        if (!hostnameOf(url) || portalOrigin !== await getPortalOrigin()) {
          throw new Error('Dieser Angebotslink ist nicht verfügbar.');
        }
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
        break;
      }

      case 'openShopLink': {
        if (!hostnameOf(msg.shopUrl)) {
          sendResponse({ ok: false, error: 'Ungültige Shop-Adresse.' });
          break;
        }
        await chrome.tabs.create({ url: msg.shopUrl });
        sendResponse({ ok: true, url: msg.shopUrl });
        break;
      }

      case 'searchCatalog': {
        const query = (msg.query || '').trim();
        const catalog = await getStore(portalOrigin, STORAGE_KEYS.CATALOG, null);
        const qNorm = normalize(query);
        const localMatches = [];

        if (catalog?.offers && qNorm) {
          for (const offer of Object.values(catalog.offers)) {
            if (
              normalize(offer.name).includes(qNorm) ||
              normalize(offer.teaser).includes(qNorm)
            ) {
              localMatches.push(offer);
            }
          }
        }

        sendResponse({ ok: true, results: localMatches.slice(0, 25) });
        break;
      }

      case 'searchPortal': {
        const query = (msg.query || '').trim();
        if (query.length < 2) throw new Error('Gib mindestens zwei Zeichen ein.');
        try {
          const results = await searchPortalOffers(query, portalOrigin);
          sendResponse({ ok: true, results: results.slice(0, 25) });
        } catch (error) {
          if (error instanceof SessionExpiredError) await updateSessionState(portalOrigin, false, error.message);
          throw error;
        }
        break;
      }

      case 'getOfferDetail': {
        const detail = await getOrFetchOfferDetail(portalOrigin, msg.offerId, msg.path);
        const couponState = await popupCodes(portalOrigin, [detail]);
        if (portalOrigin !== await getPortalOrigin()) {
          throw new Error('Das Unternehmensportal wurde geändert. Öffne die Erweiterung erneut.');
        }
        sendResponse({ ok: true, detail, ...couponState });
        break;
      }

      default:
        sendResponse({ ok: false, error: `Unbekannter Nachrichtentyp: ${msg.type}` });
    }
  })().catch((err) => {
    sendResponse({
      ok: false,
      error: err?.message || String(err),
      code: err?.code || null,
    });
  });

  return true; // async response
});
