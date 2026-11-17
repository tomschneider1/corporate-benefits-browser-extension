import { COUPON_SESSION_KEY } from '../lib/coupon-session.js';

const domainLabel = document.getElementById('domainLabel');
const syncBtn = document.getElementById('syncBtn');
const sessionBanner = document.getElementById('sessionBanner');
const loginLink = document.getElementById('loginLink');
const searchInput = document.getElementById('searchInput');
const loadingState = document.getElementById('loadingState');
const offersContainer = document.getElementById('offersContainer');
const searchResultsContainer = document.getElementById('searchResultsContainer');
const catalogStatus = document.getElementById('catalogStatus');
const portalHomeLink = document.getElementById('portalHomeLink');

const portalSettings = document.getElementById('portalSettings');
const portalForm = document.getElementById('portalForm');
const portalInput = document.getElementById('portalInput');
const portalSave = document.getElementById('portalSave');
const portalError = document.getElementById('portalError');

let currentPortalOrigin;
let currentCodesCache = {};
let currentCodeSessionId = null;
let visibleOffers = [];
let statusRequest = 0;
let searchTimer = null;

portalForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  portalError.classList.add('hidden');
  portalSave.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'setPortalOrigin', address: portalInput.value });
    if (!res?.ok) throw new Error(res?.error || 'Unternehmensportal konnte nicht gespeichert werden.');
    if (res.portalOrigin !== currentPortalOrigin) {
      updatePortal(res.portalOrigin);
      initPopup();
    }
    portalSettings.open = false;
  } catch (error) {
    portalError.textContent = error.message;
    portalError.classList.remove('hidden');
  } finally {
    portalSave.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  const couponChange = changes[COUPON_SESSION_KEY];
  if (area === 'session' && couponChange?.oldValue && couponChange.oldValue.id !== couponChange.newValue?.id) {
    currentCodeSessionId = null;
    currentCodesCache = {};
    if (visibleOffers.length) renderOffers(visibleOffers);
  }

  const change = changes.cb_portal_origin;
  if (area === 'local' && change && change.newValue !== currentPortalOrigin) {
    updatePortal(change.newValue);
    initPopup();
  }
});

async function matchesCouponSession(payload, portalOrigin) {
  if (!payload?.codeSessionId) return false;
  const snapshot = await chrome.storage.session.get(COUPON_SESSION_KEY);
  const session = snapshot[COUPON_SESSION_KEY];
  return portalOrigin === currentPortalOrigin && session?.id === payload.codeSessionId;
}

async function updatePopupCodeCache(payload, portalOrigin) {
  const valid = await matchesCouponSession(payload, portalOrigin);
  if (portalOrigin !== currentPortalOrigin) return;
  currentCodeSessionId = valid ? payload.codeSessionId : null;
  currentCodesCache = valid ? payload.codesCache : {};
}

function updatePortal(origin) {
  if (origin === currentPortalOrigin) return;
  currentPortalOrigin = origin;
  currentCodesCache = {};
  currentCodeSessionId = null;
  visibleOffers = [];
  clearTimeout(searchTimer);
  searchInput.value = '';
  searchResultsContainer.replaceChildren();
  searchResultsContainer.classList.add('hidden');
  offersContainer.replaceChildren();
  offersContainer.classList.remove('hidden');
  updateSessionBanner(null);
  updateCatalogFooter({});

  portalSettings.open = !origin;
  portalInput.value = origin || '';
  if (origin) {
    loginLink.href = `${origin}/login`;
    portalHomeLink.href = `${origin}/`;
  }
  syncBtn.disabled = !origin;
  syncBtn.textContent = '↻ Sync';
  document.getElementById('searchBar').classList.toggle('hidden', !origin);
  document.getElementById('catalogFooter').classList.toggle('hidden', !origin);
}

async function initPopup() {
  const request = ++statusRequest;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url || '';

  chrome.runtime.sendMessage({ type: 'getStatusForTab', url: tabUrl }, async (res) => {
    if (request !== statusRequest) return;
    loadingState.classList.add('hidden');
    if (chrome.runtime.lastError || !res?.ok) {
      domainLabel.textContent = 'Status konnte nicht geladen werden';
      renderEmptyState(res?.error || 'Unbekannter Fehler.');
      return;
    }

    updatePortal(res.catalogStats?.portalOrigin ?? null);
    if (!currentPortalOrigin) {
      domainLabel.textContent = 'Einrichtung';
      renderEmptyState('Melde dich nach dem Speichern im Unternehmensportal an und klicke anschließend auf Sync.');
      return;
    }
    const portalOrigin = currentPortalOrigin;
    await updatePopupCodeCache(res, portalOrigin);
    if (request !== statusRequest || portalOrigin !== currentPortalOrigin) return;
    updateCatalogFooter(res.catalogStats);
    updateSessionBanner(res.sessionState);

    if (res.domain) {
      domainLabel.textContent = `Shop: ${res.domain}`;
    } else {
      domainLabel.textContent = 'Kein Online-Shop im aktuellen Tab';
    }

    if (res.offers && res.offers.length > 0) {
      renderOffers(res.offers);
    } else if (res.domain) {
      renderEmptyState(
        `Für ${res.domain} wurde kein direktes Angebot gefunden. Nutze oben die Suche, falls der Anbieter unter anderem Namen gelistet ist.`,
      );
    } else {
      renderEmptyState(
        'Öffne einen Online-Shop oder nutze das Suchfeld oben, um im gesamten Corporate-Benefits-Katalog zu suchen.',
      );
    }
  });
}

function updateCatalogFooter(stats) {
  if (!stats) return;
  if (stats.offerCount > 0 && stats.updatedAt) {
    const timeStr = new Date(stats.updatedAt).toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    });
    catalogStatus.textContent = `${stats.offerCount} Angebote (${timeStr} Uhr)`;
  } else {
    catalogStatus.textContent = 'Katalog: noch nicht geladen';
  }
}

function updateSessionBanner(sessionState) {
  if (sessionState && sessionState.loggedIn === false) {
    sessionBanner.classList.remove('hidden');
  } else {
    sessionBanner.classList.add('hidden');
  }
}

function renderEmptyState(message) {
  visibleOffers = [];
  offersContainer.replaceChildren();
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = message;
  offersContainer.appendChild(div);
}

function renderOffers(offers) {
  visibleOffers = offers;
  offersContainer.replaceChildren();
  for (const offer of offers) {
    offersContainer.appendChild(buildOfferCard(offer));
  }
}

function buildOfferCard(offer) {
  const portalOrigin = currentPortalOrigin;
  const card = document.createElement('div');
  card.className = 'offer-card';

  const top = document.createElement('div');
  top.className = 'offer-top';

  const title = document.createElement('h2');
  title.className = 'offer-title';
  title.textContent = offer.name || offer.title;
  top.appendChild(title);

  if (offer.discount) {
    const pill = document.createElement('span');
    pill.className = 'discount-pill';
    pill.textContent = offer.discount;
    top.appendChild(pill);
  }
  card.appendChild(top);

  if (offer.teaser) {
    const teaser = document.createElement('p');
    teaser.className = 'offer-teaser';
    teaser.textContent = offer.teaser;
    card.appendChild(teaser);
  }

  for (const so of offer.saleOptions || []) {
    if (so.type === 'info' && !so.description) continue;
    const box = document.createElement('div');
    box.className = 'sale-option';

    const header = document.createElement('div');
    header.className = 'sale-option-header';

    const soTitle = document.createElement('span');
    soTitle.className = 'sale-option-title';
    soTitle.textContent = so.title || 'Option';
    header.appendChild(soTitle);
    box.appendChild(header);

    if (so.description) {
      const desc = document.createElement('div');
      desc.className = 'sale-option-desc';
      desc.textContent = so.description;
      box.appendChild(desc);
    }

    const actionArea = document.createElement('div');
    box.appendChild(actionArea);

    const cacheKey = `${offer.id}:${so.soId}`;
    const cachedCodes = currentCodesCache[cacheKey];

    if (so.type === 'code') {
      if (cachedCodes?.length) {
        for (const c of cachedCodes) {
          actionArea.appendChild(buildCodeRow(c));
        }
      } else {
        const btn = document.createElement('button');
        btn.className = 'primary-btn';
        btn.textContent = 'Jetzt Gutschein abrufen';
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = 'Rufe Code ab…';
          chrome.runtime.sendMessage(
            {
              type: 'requestCode',
              portalOrigin,
              codeSessionId: currentCodeSessionId,
              offerId: offer.id,
              saleOptionId: so.soId,
            },
            async (resp) => {
              if (portalOrigin !== currentPortalOrigin || !actionArea.isConnected) return;
              const valid = resp?.ok && resp.codes?.length && await matchesCouponSession(resp, portalOrigin);
              if (portalOrigin !== currentPortalOrigin || !actionArea.isConnected) return;
              if (!valid) {
                btn.disabled = false;
                btn.textContent = 'Erneut versuchen';
                if (resp?.code === 'session_expired') {
                  updateSessionBanner({ loggedIn: false });
                }
                const err = document.createElement('div');
                err.className = 'error-msg';
                err.textContent = resp?.error || 'Code konnte nicht geladen werden.';
                actionArea.appendChild(err);
                return;
              }
              currentCodeSessionId = resp.codeSessionId;
              currentCodesCache[cacheKey] = resp.codes;
              actionArea.replaceChildren();
              for (const c of resp.codes) {
                actionArea.appendChild(buildCodeRow(c));
              }
            },
          );
        });
        actionArea.appendChild(btn);
      }

      if (so.shopUrl) {
        const shopBtn = document.createElement('button');
        shopBtn.className = 'secondary-btn';
        shopBtn.textContent = 'Zum Onlineshop öffnen ↗';
        shopBtn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'openShopLink', portalOrigin, shopUrl: so.shopUrl });
        });
        box.appendChild(shopBtn);
      }
    } else if (so.type === 'link' && so.shopUrl) {
      const btn = document.createElement('button');
      btn.className = 'primary-btn';
      btn.textContent = 'Über Aktionslink zum Shop ↗';
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'openShopLink', portalOrigin, shopUrl: so.shopUrl });
      });
      actionArea.appendChild(btn);
    } else if (so.type === 'pdf' && so.downloadPath) {
      const a = document.createElement('a');
      a.className = 'secondary-btn';
      a.href = `${portalOrigin}${so.downloadPath}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Filialgutschein (PDF) herunterladen';
      actionArea.appendChild(a);
    }

    card.appendChild(box);
  }

  return card;
}

function buildCodeRow(code) {
  const row = document.createElement('div');
  row.className = 'code-row';

  const val = document.createElement('span');
  val.className = 'code-value';
  val.textContent = code;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Kopieren';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copyBtn.textContent = 'Kopiert!';
      setTimeout(() => {
        copyBtn.textContent = 'Kopieren';
      }, 1600);
    } catch {
      copyBtn.textContent = 'Fehler';
    }
  });

  row.append(val, copyBtn);
  return row;
}

// ---------------------------------------------------------------------------
// Manual catalogue sync
// ---------------------------------------------------------------------------

syncBtn.addEventListener('click', () => {
  const portalOrigin = currentPortalOrigin;
  syncBtn.disabled = true;
  syncBtn.textContent = 'Lädt…';
  chrome.runtime.sendMessage({ type: 'syncCatalog', portalOrigin, force: true }, (res) => {
    if (portalOrigin !== currentPortalOrigin) return;
    syncBtn.disabled = false;
    syncBtn.textContent = '↻ Sync';
    if (!res?.ok) {
      if (res?.code === 'session_expired') {
        updateSessionBanner({ loggedIn: false });
      }
      renderEmptyState(res?.error || 'Synchronisation fehlgeschlagen.');
      return;
    }
    updateSessionBanner({ loggedIn: true });
    updateCatalogFooter({
      offerCount: res.offerCount,
      updatedAt: res.updatedAt,
    });
    initPopup();
  });
});

// ---------------------------------------------------------------------------
// Live search across the catalogue
// ---------------------------------------------------------------------------

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (!query) {
    searchResultsContainer.classList.add('hidden');
    offersContainer.classList.remove('hidden');
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), 200);
});

function runSearch(query, type = 'searchCatalog') {
  const portalOrigin = currentPortalOrigin;
  offersContainer.classList.add('hidden');
  searchResultsContainer.classList.remove('hidden');
  searchResultsContainer.textContent = 'Suche…';

  chrome.runtime.sendMessage({ type, portalOrigin, query }, (res) => {
    if (portalOrigin !== currentPortalOrigin || searchInput.value.trim() !== query) return;
    searchResultsContainer.replaceChildren();
    if (!res?.ok) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.textContent = res?.error || 'Suche fehlgeschlagen.';
      if (res?.code === 'session_expired') updateSessionBanner({ loggedIn: false });
      searchResultsContainer.appendChild(div);
      return;
    }
    if (!res.results?.length) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.textContent = `Keine Treffer für „${query}“.`;
      if (type === 'searchCatalog' && query.length >= 2) {
        const button = document.createElement('button');
        button.className = 'secondary-btn';
        button.textContent = 'Im Unternehmensportal suchen';
        button.addEventListener('click', () => runSearch(query, 'searchPortal'));
        div.appendChild(button);
      }
      searchResultsContainer.appendChild(div);
      return;
    }

    for (const item of res.results) {
      const row = document.createElement('div');
      row.className = 'search-result-item';

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'search-result-name';
      name.textContent = item.name;
      const sub = document.createElement('div');
      sub.className = 'search-result-sub';
      sub.textContent = item.teaser || item.categoryName || '';
      left.append(name, sub);

      row.appendChild(left);
      if (item.discount) {
        const pill = document.createElement('span');
        pill.className = 'discount-pill';
        pill.textContent = item.discount;
        row.appendChild(pill);
      }

      row.addEventListener('click', () => {
        searchResultsContainer.textContent = 'Lade Angebotsdetails…';
        chrome.runtime.sendMessage(
          { type: 'getOfferDetail', portalOrigin, offerId: item.id, path: item.path },
          async (detailRes) => {
            if (portalOrigin !== currentPortalOrigin || searchInput.value.trim() !== query) return;
            if (!detailRes?.ok || !detailRes.detail) {
              searchResultsContainer.textContent =
                detailRes?.error || 'Angebot konnte nicht geladen werden.';
              return;
            }
            await updatePopupCodeCache(detailRes, portalOrigin);
            if (portalOrigin !== currentPortalOrigin || searchInput.value.trim() !== query) return;
            searchResultsContainer.classList.add('hidden');
            offersContainer.classList.remove('hidden');
            renderOffers([detailRes.detail]);
          },
        );
      });

      searchResultsContainer.appendChild(row);
    }
  });
}

initPopup();
