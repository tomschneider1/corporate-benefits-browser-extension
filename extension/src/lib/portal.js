// Client for https://<company>.mitarbeiterangebote.de using the user's existing
// browser session cookies (credentials: 'include').

const PORTAL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mitarbeiterangebote\.de$/;

export function normalizePortalOrigin(input) {
  if (typeof input !== 'string' || !input.trim()) return null;

  const address = input.trim();
  try {
    const url = new URL(address.includes('://') ? address : `https://${address}`);
    if (
      url.protocol === 'https:' && PORTAL_HOST.test(url.hostname) &&
      !url.username && !url.password && !url.port
    ) {
      return url.origin;
    }
  } catch {
    return null;
  }
  return null;
}

function portalUrl(path, origin) {
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password) {
    throw new Error('Die Anfrage muss an das eingerichtete Unternehmensportal gehen.');
  }
  return url;
}

export class SessionExpiredError extends Error {
  constructor(message = 'Corporate Benefits Sitzung ist abgelaufen') {
    super(message);
    this.name = 'SessionExpiredError';
    this.code = 'session_expired';
  }
}

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (typeof chrome === 'undefined' || !chrome.offscreen) return;
  if (chrome.runtime?.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length > 0) return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parse Corporate Benefits HTML responses with DOMParser',
      })
      .catch((err) => {
        // Ignore if already created by a concurrent call.
        if (!String(err?.message || err).includes('Only a single offscreen')) {
          throw err;
        }
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

export async function parseHtmlViaOffscreen(kind, html, extra = {}) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'parse',
    kind,
    html,
    ...extra,
  });
  if (!res) throw new Error('Keine Antwort vom HTML-Parser (Offscreen)');
  if (!res.ok) {
    if (res.error === 'session_expired') throw new SessionExpiredError();
    throw new Error(res.error || 'Parse-Fehler');
  }
  return res.data;
}

async function fetchPortalHtml(path, origin) {
  const url = portalUrl(path, origin);
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (res.url && res.url.includes('/login')) {
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} beim Laden von ${path}`);
  }
  return await res.text();
}

export async function fetchCategories(origin) {
  const html = await fetchPortalHtml('/', origin);
  return await parseHtmlViaOffscreen('categories', html);
}

export async function fetchCategoryOffers(catPath, origin) {
  const html = await fetchPortalHtml(catPath, origin);
  return await parseHtmlViaOffscreen('offerList', html);
}

export async function fetchOfferDetail(offerPath, offerId, origin) {
  if (!portalUrl(offerPath, origin).pathname.startsWith('/offer/')) {
    throw new Error('Ungültige Angebotsadresse.');
  }
  const html = await fetchPortalHtml(offerPath, origin);
  return await parseHtmlViaOffscreen('offer', html, { offerId });
}

export async function searchPortalOffers(query, origin) {
  const res = await fetch(`${origin}/api/search`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/xml; charset=utf-8, text/html; q=0.9, */*; q=0.8',
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({ search: query }),
  });
  if (res.url && res.url.includes('/login')) {
    throw new SessionExpiredError();
  }
  if (res.status === 401 || res.status === 403) {
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    throw new Error(`Suche fehlgeschlagen (HTTP ${res.status})`);
  }
  const html = await res.text();
  if (html.includes('Keine Suchergebnisse')) return [];
  return await parseHtmlViaOffscreen('offerList', `<main>${html}</main>`);
}

/**
 * Request a personal/general coupon code on demand.
 * Mirrors the exact XHR sent by cbg3's `code.request` module in app.js.
 */
export async function requestCouponCode(
  { url, offerId, saleOptionId },
  origin,
) {
  const endpoint = url || `/api/coupon?ac=${Math.floor(Date.now() / 1000)}`;
  const fullUrl = portalUrl(endpoint, origin);
  if (fullUrl.pathname !== '/api/coupon') throw new Error('Ungültiger Gutschein-Endpunkt.');
  const res = await fetch(fullUrl, {
    method: 'POST',
    credentials: 'include',
    redirect: 'manual',
    headers: {
      Accept: 'application/json; charset=utf-8',
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      offerId: String(offerId),
      saleOptionId: String(saleOptionId),
    }),
  });
  if (res.type === 'opaqueredirect' || (res.url && res.url.includes('/login'))) {
    throw new SessionExpiredError();
  }
  if (res.status === 401 || res.status === 403) {
    throw new SessionExpiredError();
  }
  if (res.status === 404) {
    throw new Error('Derzeit sind für dieses Angebot leider keine Codes verfügbar.');
  }
  if (!res.ok) {
    throw new Error(`Code-Abruf fehlgeschlagen (HTTP ${res.status})`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new SessionExpiredError();
  }
  if (!data?.success || !Array.isArray(data.code) || data.code.length === 0) {
    throw new Error('Kein Gutscheincode in der Server-Antwort enthalten.');
  }
  return data.code;
}
