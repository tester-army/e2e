/** Hostname checks, kept free of imports so `e2e init` can use them without loading URL handling. */

/** True for loopback hosts where plain HTTP is allowed. */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '[::1]') return true;
  if (/^127(\.\d{1,3}){3}$/.test(hostname)) return true;
  return false;
}
