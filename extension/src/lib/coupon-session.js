// Coupon codes last for one browser/portal session. Only opaque session IDs
// reach the popup. Cookie values are used in memory to detect account changes.
export const COUPON_SESSION_KEY = chrome.extension?.inIncognitoContext
  ? 'cb_coupon_session_incognito_v1'
  : 'cb_coupon_session_v1';

let pending = Promise.resolve();

function withSession(update) {
  const task = pending.then(async () => {
    const stored = await chrome.storage.session.get(COUPON_SESSION_KEY);
    return update(stored[COUPON_SESSION_KEY]);
  });
  pending = task.catch(() => {});
  return task;
}

async function cookieFingerprint(portalOrigin) {
  const cookies = await chrome.cookies.getAll({ url: portalOrigin + '/api/coupon' });
  const entries = cookies
    .map(({ domain, path, name, value, storeId }) => JSON.stringify([domain, path, name, value, storeId]))
    .sort();
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function refreshSession(portalOrigin, session) {
  const fingerprint = await cookieFingerprint(portalOrigin);
  if (session?.portalOrigin === portalOrigin && session.fingerprint === fingerprint) return session;

  const next = { portalOrigin, fingerprint, id: crypto.randomUUID(), codes: {} };
  await chrome.storage.session.set({ [COUPON_SESSION_KEY]: next });
  return next;
}

export function getCouponSession(portalOrigin) {
  return withSession((session) => refreshSession(portalOrigin, session));
}

export function refreshCouponSession(portalOrigin) {
  return withSession((session) => {
    if (session?.portalOrigin === portalOrigin) return refreshSession(portalOrigin, session);
  });
}

export function clearCouponSession(portalOrigin) {
  return withSession((session) => {
    if (!portalOrigin || session?.portalOrigin === portalOrigin) {
      return chrome.storage.session.remove(COUPON_SESSION_KEY);
    }
  });
}

export function rememberCouponCodes(portalOrigin, sessionId, key, values) {
  return withSession(async (stored) => {
    if (stored?.id !== sessionId || stored.portalOrigin !== portalOrigin) return false;
    const session = await refreshSession(portalOrigin, stored);
    if (session.id !== sessionId) return false;

    await chrome.storage.session.set({
      [COUPON_SESSION_KEY]: { ...session, codes: { ...session.codes, [key]: values } },
    });
    return true;
  });
}
