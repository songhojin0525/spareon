/** Minimal cookie parsing and serialization (RFC 6265 subset: the server only sets its own cookies). */

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      value = value.slice(1, -1);
    // First occurrence wins (browsers send the most specific path first).
    if (name !== '' && !out.has(name)) out.set(name, value);
  }
  return out;
}

export interface CookieOptions {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  /** Seconds; 0 deletes the cookie. */
  readonly maxAgeS: number;
}

const VALUE_RE = /^[A-Za-z0-9_\-.]*$/;

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!VALUE_RE.test(value)) throw new Error('serializeCookie: unsupported characters in value');
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${String(options.maxAgeS)}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export interface CookieNames {
  readonly session: string;
  readonly csrf: string;
}

/** `__Host-` names (Secure, Path=/, no Domain enforced by browsers) when served over https. */
export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { session: '__Host-spareon_session', csrf: '__Host-spareon_csrf' }
    : { session: 'spareon_session', csrf: 'spareon_csrf' };
}
