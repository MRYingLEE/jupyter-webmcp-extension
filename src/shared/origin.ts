/**
 * Origin helpers shared by the service worker and the extension pages.
 */

/** The normalized origin of a URL, or `null` for non-web URLs. */
export function webOrigin(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Whether a value is exactly a normalized http(s) origin, with no path or wildcard. */
export function isWebOrigin(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('*') &&
    webOrigin(value) === value
  );
}

/** The host permission pattern that covers an origin. */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}
