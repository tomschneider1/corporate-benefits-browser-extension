// Content script injected into normal shop pages.
// Queries the background service worker whether Corporate Benefits offers exist
// for the current domain and renders an unobtrusive, Honey-style floating card
// inside an isolated Shadow DOM so shop styles never collide.

(function initCorporateBenefitsBanner() {
  if (window.top !== window.self) return;
  const host = location.hostname.toLowerCase();
  if (
    !location.protocol.startsWith('http') ||
    host.endsWith('mitarbeiterangebote.de') ||
    host.endsWith('corporate-benefits.de')
  ) {
    return;
  }

  let portalChanged = false;
  let bannerHost;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'portalChanged') {
      portalChanged = true;
      bannerHost?.remove();
    }
  });

  chrome.runtime.sendMessage(
    { type: 'getStatusForTab' },
    (res) => {
      if (chrome.runtime.lastError || !res?.ok || portalChanged) return;
      if (res.isDismissed || !Array.isArray(res.offers) || res.offers.length === 0) {
        return;
      }
      renderBanner(res.domain, res.offers, res.catalogStats?.portalOrigin);
    },
  );

  function renderBanner(domain, offers, portalOrigin) {
    if (document.getElementById('cb-helper-shadow-host')) return;

    let selectedIdx = 0;

    const hostEl = document.createElement('div');
    bannerHost = hostEl;
    hostEl.id = 'cb-helper-shadow-host';
    hostEl.style.all = 'initial';
    const shadow = hostEl.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
      }
      .cb-card {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483646;
        width: 340px;
        max-width: calc(100vw - 32px);
        background: #0f172a;
        color: #f8fafc;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.45;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        box-shadow: 0 20px 40px rgba(2, 6, 23, 0.45);
        overflow: hidden;
        animation: cbSlideIn 0.22s ease-out;
      }
      @keyframes cbSlideIn {
        from { opacity: 0; transform: translateY(-10px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .cb-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 11px 14px;
        background: linear-gradient(135deg, #16a34a 0%, #15803d 100%);
        color: #ffffff;
      }
      .cb-badge-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
        font-size: 13px;
      }
      .cb-pill {
        background: rgba(255, 255, 255, 0.2);
        padding: 2px 7px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
      }
      .cb-close {
        all: unset;
        cursor: pointer;
        opacity: 0.85;
        font-size: 16px;
        line-height: 1;
        padding: 2px 6px;
        border-radius: 6px;
      }
      .cb-close:hover {
        opacity: 1;
        background: rgba(0, 0, 0, 0.15);
      }
      .cb-tabs {
        display: flex;
        gap: 4px;
        padding: 8px 14px 0;
        overflow-x: auto;
      }
      .cb-tab {
        all: unset;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 8px;
        border-radius: 6px;
        background: #1e293b;
        color: #94a3b8;
        white-space: nowrap;
        border: 1px solid transparent;
      }
      .cb-tab.active {
        background: rgba(34, 197, 94, 0.16);
        color: #4ade80;
        border-color: rgba(34, 197, 94, 0.4);
      }
      .cb-body {
        padding: 12px 14px 14px;
      }
      .cb-title {
        font-weight: 700;
        font-size: 14px;
        color: #ffffff;
        margin-bottom: 4px;
      }
      .cb-sub {
        color: #cbd5e1;
        font-size: 12px;
        margin-bottom: 10px;
      }
      .cb-option {
        background: #1e293b;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 10px;
        padding: 9px 10px;
        margin-top: 8px;
      }
      .cb-option-title {
        font-weight: 600;
        font-size: 12px;
        color: #f1f5f9;
        margin-bottom: 6px;
      }
      .cb-btn {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        padding: 7px 10px;
        border-radius: 8px;
        background: #22c55e;
        color: #052e16;
        font-weight: 700;
        font-size: 12px;
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .cb-btn:hover {
        background: #4ade80;
      }
      .cb-btn:disabled {
        opacity: 0.6;
        cursor: wait;
      }
      .cb-option-hint {
        color: #cbd5e1;
        font-size: 12px;
      }
      .cb-error {
        color: #fca5a5;
        font-size: 11px;
        margin-top: 6px;
      }
    `;

    const card = document.createElement('div');
    card.className = 'cb-card';
    shadow.append(style, card);
    document.documentElement.appendChild(hostEl);

    function renderSelectedOffer() {
      card.replaceChildren();
      const primary = offers[selectedIdx] || offers[0];
      const actionableOptions = (primary.saleOptions || []).filter((so) => so.type !== 'info');

      const header = document.createElement('div');
      header.className = 'cb-header';

      const badgeRow = document.createElement('div');
      badgeRow.className = 'cb-badge-row';
      badgeRow.textContent = 'Corporate Benefits';
      if (primary.discount) {
        const pill = document.createElement('span');
        pill.className = 'cb-pill';
        pill.textContent = primary.discount;
        badgeRow.appendChild(pill);
      }

      const closeBtn = document.createElement('button');
      closeBtn.className = 'cb-close';
      closeBtn.title = 'Für heute auf dieser Seite ausblenden';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => {
        hostEl.remove();
        chrome.runtime.sendMessage({ type: 'dismissBannerForDomain', portalOrigin, domain });
      });

      header.append(badgeRow, closeBtn);
      card.appendChild(header);

      if (offers.length > 1) {
        const tabs = document.createElement('div');
        tabs.className = 'cb-tabs';
        offers.forEach((off, idx) => {
          const t = document.createElement('button');
          t.className = `cb-tab${idx === selectedIdx ? ' active' : ''}`;
          t.textContent = `${off.name || off.title}${off.discount ? ` (${off.discount})` : ''}`;
          t.addEventListener('click', () => {
            selectedIdx = idx;
            renderSelectedOffer();
          });
          tabs.appendChild(t);
        });
        card.appendChild(tabs);
      }

      const body = document.createElement('div');
      body.className = 'cb-body';

      const titleEl = document.createElement('div');
      titleEl.className = 'cb-title';
      titleEl.textContent = primary.name || primary.title;

      const subEl = document.createElement('div');
      subEl.className = 'cb-sub';
      subEl.textContent = primary.teaser || 'Mitarbeiterangebot für diesen Shop verfügbar';

      body.append(titleEl, subEl);

      for (const so of actionableOptions.slice(0, 3)) {
        const optBox = document.createElement('div');
        optBox.className = 'cb-option';

        const optTitle = document.createElement('div');
        optTitle.className = 'cb-option-title';
        optTitle.textContent = so.title || 'Vorteil nutzen';
        optBox.appendChild(optTitle);

        const actionWrap = document.createElement('div');
        optBox.appendChild(actionWrap);

        if (so.type === 'code') {
          actionWrap.className = 'cb-option-hint';
          actionWrap.textContent = 'Gutscheincode im Erweiterungsmenü abrufen.';
        } else {
          const button = document.createElement('button');
          button.className = 'cb-btn';
          button.textContent = so.type === 'pdf'
            ? 'Filialgutschein (PDF) öffnen'
            : 'Über CB-Aktionslink öffnen ↗';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              const result = await chrome.runtime.sendMessage({
                type: 'openBannerLink', portalOrigin, offerId: primary.id, saleOptionId: so.soId,
              });
              if (!result?.ok) throw new Error(result?.error || 'Angebotslink konnte nicht geöffnet werden.');
            } catch (error) {
              const message = document.createElement('div');
              message.className = 'cb-error';
              message.textContent = error.message;
              actionWrap.appendChild(message);
            } finally {
              button.disabled = false;
            }
          });
          actionWrap.appendChild(button);
        }

        body.appendChild(optBox);
      }

      card.appendChild(body);
    }

    renderSelectedOffer();
  }

})();
