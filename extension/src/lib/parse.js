// Pure HTML -> data parsers for the Corporate Benefits portal ("cbg3" frontend).
// Every function takes a DOM `Document` so it works in the offscreen document
// (DOMParser) as well as in Node tests (linkedom).

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** True if the HTML is the login page, i.e. the session is missing/expired. */
export function isLoginPage(doc) {
  return Boolean(
    doc.getElementById('loginData[email]') ||
      doc.getElementById('cbg3-submit-login') ||
      doc.querySelector('form[action="/login"] input[type="password"]'),
  );
}

/** Top-level categories from the main navigation: [{id, name, path}] */
export function parseCategories(doc) {
  const seen = new Map();
  for (const a of doc.querySelectorAll('a[href^="/overview/"]')) {
    const href = a.getAttribute('href').trim();
    const m = href.match(/^\/overview\/(\d+)$/);
    if (!m || seen.has(m[1])) continue;
    seen.set(m[1], { id: m[1], name: text(a), path: href });
  }
  return [...seen.values()];
}

/**
 * Offer list items of a category (/overview/<id>) or search (/search?s=) page.
 * Returns [{id, cat, path, name, teaser, discount, restDays, local}]
 */
export function parseOfferList(doc) {
  const root = doc.querySelector('main') || doc;
  const offers = new Map();
  for (const item of root.querySelectorAll('.cbg3-list-item[data-id]')) {
    const id = item.getAttribute('data-id');
    if (!id || offers.has(id)) continue;
    const link = item.querySelector('a[href^="/offer/"]');
    const path = link ? link.getAttribute('href') : `/offer/${id}`;
    const catMatch = path.match(/\/cat\/(\d+)/);
    const h3 = item.querySelector('.cbg3-offer-list-item--content h3');
    let name = text(h3).replace(/\s*-\s*$/, '');
    if (!name && link) name = (link.getAttribute('title') || '').replace(/^Zum Angebot:\s*/, '');
    offers.set(id, {
      id,
      cat: catMatch ? catMatch[1] : null,
      path,
      name,
      teaser: text(item.querySelector('.cbg3-list-item--copy')),
      discount: text(item.querySelector('.cbg3-list-item--discount')),
      restDays: text(item.querySelector('.cbg3-offer-list-item--rest-days')) || null,
      breadcrumb: text(item.querySelector('.cbg3-list-item--breadcrumb')) || null,
      local: Boolean(item.getAttribute('data-zipcode')),
    });
  }
  return [...offers.values()];
}

/**
 * Detail page /offer/<id>/cat/<cat>.
 * Sale option types:
 *   code  – "Jetzt Gutschein abrufen" button (POST /api/coupon)
 *   link  – only a shop link, discount is applied in the shop
 *   pdf   – downloadable store voucher
 *   info  – plain information (contact etc.)
 */
export function parseOfferPage(doc, offerId) {
  const main = doc.querySelector('main') || doc;
  const title = text(main.querySelector('h1'));
  const discount = text(main.querySelector('.cbg3-discount-and-location')).replace(/^km\s*/, '');
  const claim = text(main.querySelector('.cbg3-text-claim h3'));

  const saleOptions = [];
  for (const item of main.querySelectorAll('.cbg3-salesoption--item')) {
    const soId = item.getAttribute('data-so-id');
    const btn = item.querySelector('button.cbg3-code-request');
    const shopEl = item.querySelector('[data-href]');
    const pdfEl = item.querySelector('a[href^="/download/"]');
    const staticCode = text(item.querySelector('.cbg3-salesoption--code'));

    // Description without buttons, error templates and the code container.
    const clone = item.cloneNode(true);
    for (const el of clone.querySelectorAll(
      'h3, .cbg3-salesoption--code, .cbg3-salesoption--request, .cbg3-salesoption--response-error, .cbg3-button--standard, script',
    )) {
      el.remove();
    }

    let type = 'info';
    if (btn || staticCode) type = 'code';
    else if (shopEl) type = 'link';
    else if (pdfEl) type = 'pdf';

    saleOptions.push({
      soId,
      title: text(item.querySelector('h3')),
      description: text(clone),
      type,
      codeRequest: btn
        ? {
            url: btn.getAttribute('data-url'),
            offerId: btn.getAttribute('data-offerid') || String(offerId),
            saleOptionId: btn.getAttribute('data-salesoptionid') || soId,
          }
        : null,
      staticCode: staticCode || null,
      shopUrl: shopEl ? shopEl.getAttribute('data-href') : null,
      downloadPath: pdfEl ? pdfEl.getAttribute('href') : null,
    });
  }

  return { id: String(offerId), title, discount, claim, saleOptions };
}
