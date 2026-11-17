// MV3 service workers have no DOMParser, so HTML parsing happens here.
import { isLoginPage, parseCategories, parseOfferList, parseOfferPage } from '../lib/parse.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'parse') return false;
  try {
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    if (isLoginPage(doc)) {
      sendResponse({ ok: false, error: 'session_expired' });
      return false;
    }
    let data;
    switch (msg.kind) {
      case 'categories':
        data = parseCategories(doc);
        break;
      case 'offerList':
        data = parseOfferList(doc);
        break;
      case 'offer':
        data = parseOfferPage(doc, msg.offerId);
        break;
      default:
        throw new Error(`unknown parse kind ${msg.kind}`);
    }
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: String(e?.message || e) });
  }
  return false;
});
