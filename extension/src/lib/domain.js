// Helpers to normalise shop hostnames and offer names so we can match a visited
// website against the Corporate Benefits catalogue.

// Small list of multi-label public suffixes that are relevant for German users.
// (A full Public Suffix List would be overkill for this use-case.)
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk',
  'co.at', 'or.at',
  'com.au', 'net.au',
  'co.nz', 'co.jp', 'co.kr', 'co.za', 'co.in',
  'com.br', 'com.tr', 'com.mx', 'com.ar', 'com.cn', 'com.pl', 'com.es',
]);

/** "checkout.shop.zalando.de" -> "zalando.de" */
export function registrableDomain(hostname) {
  if (!hostname) return '';
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\d*\./, '');
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/** "zalando-lounge.de" -> "zalandolounge" (brand part without TLD) */
export function brandToken(domain) {
  const rd = registrableDomain(domain);
  const first = rd.split('.')[0] || '';
  return normalize(first);
}

export function hostnameOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname;
  } catch {
    return '';
  }
}

/** Lowercase, transliterate umlauts, strip everything but a-z0-9. */
export function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** First word of an offer name, normalised ("LG Electronics Germany" -> "lg"). */
export function firstWord(name) {
  const w = (name || '').trim().split(/[\s\-–|:,/]+/)[0];
  return normalize(w);
}

/**
 * Heuristic: could the offer with this name belong to a shop with this brand token?
 * Used only to pick candidates whose detail page we then fetch to confirm.
 */
export function nameMatchesToken(name, token) {
  if (!token) return false;
  const compact = normalize(name);
  const fw = firstWord(name);
  if (fw && fw === token) return true;
  if (token.length >= 4 && compact.startsWith(token)) return true;
  if (compact.length >= 4 && token.startsWith(compact)) return true;
  return false;
}
