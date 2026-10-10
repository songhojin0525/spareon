import { hashPassword } from '../../src/auth/password.js';
import { createUser } from '../../src/auth/users.js';
import type { UserRole } from '../../src/db/schema/index.js';
import type { Harness } from './skeleton.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestOptions {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Send x-csrf-token from the CSRF cookie on unsafe methods (default true). */
  readonly csrf?: boolean;
  /** Origin header: default WEB_ORIGIN; null sends none. */
  readonly origin?: string | null;
}

/** A minimal browser: a cookie jar, the web origin on every request, the CSRF header on writes. */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(
    readonly baseUrl: string,
    readonly origin: string,
    readonly names: { session: string; csrf: string } = {
      session: 'spareon_session',
      csrf: 'spareon_csrf',
    },
  ) {}

  static of(h: Harness): Browser {
    const names = h.server.http.cookies;
    return new Browser(h.baseUrl, h.env.WEB_ORIGIN, names);
  }

  get sessionToken(): string | undefined {
    return this.cookies.get(this.names.session);
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookies.size > 0) {
      headers['cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const origin = options.origin === undefined ? this.origin : options.origin;
    if (origin !== null) headers['origin'] = origin;
    const csrf = this.cookies.get(this.names.csrf);
    if (UNSAFE.has(method) && options.csrf !== false && csrf !== undefined) {
      headers['x-csrf-token'] = csrf;
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (pair === undefined || eq < 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (/max-age=0/i.test(c) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    // Read the whole body now, as a browser does: an unread large body keeps the connection busy.
    const body = await res.arrayBuffer();
    return new Response(body.byteLength === 0 ? null : body, {
      status: res.status,
      headers: res.headers,
    });
  }

  /** GET /api/auth/csrf (sets the CSRF cookie). */
  async primeCsrf(): Promise<string> {
    const res = await this.request('GET', '/api/auth/csrf');
    return ((await res.json()) as { csrfToken: string }).csrfToken;
  }

  async login(email: string, password: string): Promise<Response> {
    if (!this.cookies.has(this.names.csrf)) await this.primeCsrf();
    return this.request('POST', '/api/auth/login', { body: { email, password } });
  }
}

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly role: UserRole;
}

let counter = 0;

/** A user with a real argon2id password, created directly in the database. */
export async function createTestUser(
  h: Harness,
  role: UserRole,
  email?: string,
): Promise<TestUser> {
  counter += 1;
  const address = email ?? `${role}-${String(counter)}-${String(Date.now())}@test.spareon`;
  const password = `pw-${role}-${String(counter)}-correct horse`;
  const ids = h.server.http.ids;
  const id = await createUser(
    h.app.db,
    { clock: h.server.http.clock, ids },
    {
      email: address,
      role,
      displayName: `${role} ${String(counter)}`,
      passwordHash: await hashPassword(password),
    },
  );
  return { id, email: address.toLowerCase(), password, role };
}

/** A browser logged in as `user`. */
export async function loggedIn(h: Harness, user: TestUser): Promise<Browser> {
  const b = Browser.of(h);
  const res = await b.login(user.email, user.password);
  if (res.status !== 200) throw new Error(`login failed: ${String(res.status)}`);
  return b;
}

export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}
