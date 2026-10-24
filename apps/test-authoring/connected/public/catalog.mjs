export const products = [
  { id: 'trail-pack', name: 'Trail Backpack', priceCents: 8000, eligibleMerchandise: true },
  { id: 'camp-jacket', name: 'Camp Jacket', priceCents: 5000, eligibleMerchandise: true },
  { id: 'titanium-mug', name: 'Titanium Mug', priceCents: 2500, eligibleMerchandise: true },
  { id: 'cafe-mug', name: 'Café Mug', priceCents: 2000, eligibleMerchandise: true },
  { id: 'gift-card-25', name: '$25 Gift Card', priceCents: 2500, eligibleMerchandise: false },
  { id: 'enamel-cup', name: 'Enamel Cup', priceCents: 2499, eligibleMerchandise: true },
  { id: 'steel-bottle', name: 'Steel Bottle', priceCents: 2501, eligibleMerchandise: true },
];

/** Orders strings by Unicode scalar value rather than UTF-16 units or locale. */
export function compareCodePoints(left, right) {
  const a = Array.from(left, char => char.codePointAt(0));
  const b = Array.from(right, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Rejects unpaired UTF-16 surrogates before normalization or URL encoding. */
function scalarText(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) throw new Error('Invalid search link');
  return value;
}

/** Commits the documented Unicode White_Space trim and NFC normalization. */
export function normalizeQuery(value) {
  const text = scalarText(value);
  const whitespace = '\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  let start = 0;
  let end = text.length;
  while (start < end && whitespace.includes(text[start])) start++;
  while (end > start && whitespace.includes(text[end - 1])) end--;
  return text.slice(start, end).normalize('NFC');
}

/** Parses every query component strictly, using the first q and rejecting malformed UTF-8. */
export function parseQuery(rawSearch) {
  const search = scalarText(rawSearch).replace(/^\?/, '');
  let query = '';
  let found = false;
  for (const pair of search ? search.split('&') : []) {
    const equals = pair.indexOf('=');
    const name = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? '' : pair.slice(equals + 1);
    let key, decoded;
    try {
      key = scalarText(decodeURIComponent(name.replace(/\+/g, ' ')));
      decoded = scalarText(decodeURIComponent(value.replace(/\+/g, ' ')));
    } catch { throw new Error('Invalid search link'); }
    if (key === 'q' && !found) { query = decoded; found = true; }
  }
  return normalizeQuery(query);
}

/** Encodes only unreserved ASCII literally and preserves the committed query's case. */
export function querySuffix(query) {
  query = normalizeQuery(query);
  return query ? '?q=' + encodeURIComponent(query).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()) : '';
}

/** Selects and sorts catalog entries by the published matching rule. */
export function searchProducts(query, catalog = products) {
  const key = normalizeQuery(query).toLowerCase().normalize('NFC');
  const nameKey = product => product.name.toLowerCase().normalize('NFC');
  return catalog.filter(product => nameKey(product).includes(key)).toSorted((a, b) => compareCodePoints(nameKey(a), nameKey(b)) || compareCodePoints(a.id, b.id));
}
