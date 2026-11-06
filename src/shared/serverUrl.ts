import { DEFAULT_BASE_URL } from './constants';

/**
 * A grader address as typed or stored → the form every key uses (origin + path,
 * no trailing slash, no `user:pass@`, query or hash). Empty means the default
 * server, no scheme means https. Null when it can't be a web address.
 */
export function normalizeServerUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return DEFAULT_BASE_URL;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** This computer: `http://` to it never crosses a network. */
export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Would a password sent here travel unencrypted over a network? */
export function isInsecure(url: string): boolean {
  return new URL(url).protocol === 'http:' && !isLoopback(url);
}
