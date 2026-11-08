// Replacement for `url-join@4`, which this project only ever calls with an
// absolute http(s) base URL plus percent-encoded path segments. The slash
// handling is ported from url-join's normalize() so the results are identical
// for those inputs; the query/hash tail is kept for fidelity.

/**
 * Joins URL parts, collapsing the slashes between them.
 * @param parts url parts; the first one carries the protocol
 */
const normalize = (parts: string[]): string => {
  if (parts.length === 0) return '';

  // A bare protocol as the first part ('https:') is combined with the next
  // part, so 'https:', 'example.com' becomes 'https://example.com'.
  if (/^[^/:]+:\/*$/.test(parts[0]) && parts.length > 1) {
    const first = parts.shift() as string;
    parts[0] = first + parts[0];
  }

  // file: needs three slashes, every other protocol two.
  if (/^file:\/\/\//.test(parts[0])) {
    parts[0] = parts[0].replace(/^([^/:]+):\/*/, '$1:///');
  } else {
    parts[0] = parts[0].replace(/^([^/:]+):\/*/, '$1://');
  }

  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let component = parts[i];
    if (component === '') continue;

    if (i > 0) {
      // Drop leading slashes from every component but the first.
      component = component.replace(/^\/+/, '');
    }
    if (i < parts.length - 1) {
      // Drop trailing slashes from every component but the last.
      component = component.replace(/\/+$/, '');
    } else {
      // The last component keeps a single trailing slash.
      component = component.replace(/\/+$/, '/');
    }

    result.push(component);
  }

  let joined = result.join('/');
  // A trailing slash before parameters or a hash is removed, and `?` inside
  // parameters becomes `&`.
  joined = joined.replace(/\/(\?|&|#[^!])/g, '$1');
  const query = joined.split('?');
  const head = query.shift() as string;
  return head + (query.length > 0 ? '?' : '') + query.join('&');
};

export default function urljoin(...parts: string[]): string {
  return normalize(parts);
}
