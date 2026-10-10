/**
 * Role × action permission table. docs/PERMISSIONS.md holds the same table for people; a test parses
 * the document and fails when the two differ, when a registered route is missing from the table (or
 * the other way round), or when any row × role behaves differently over HTTP.
 *
 * - allow: the role may perform the action on anything the route addresses.
 * - own:   only on the role's own resources (the handler adds the ownership condition; someone else's
 *          resource answers 404 so its existence is not revealed).
 * - deny:  401 for anonymous callers, 403 for logged-in roles.
 */
export const ROLES = ['operator', 'owner', 'buyer', 'anonymous'] as const;
export type Role = (typeof ROLES)[number];
export type Access = 'allow' | 'own' | 'deny';

/** How the route authenticates: login session cookie, buyer API key (Bearer), or none needed. */
export type AuthKind = 'session' | 'api_key' | 'public';

export interface PermissionRow {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly auth: AuthKind;
  readonly access: Readonly<Record<Role, Access>>;
}

const row = (
  method: PermissionRow['method'],
  path: string,
  auth: AuthKind,
  operator: Access,
  owner: Access,
  buyer: Access,
  anonymous: Access,
): PermissionRow => ({ method, path, auth, access: { operator, owner, buyer, anonymous } });

export const PERMISSIONS = {
  'health.live': row('GET', '/healthz', 'public', 'allow', 'allow', 'allow', 'allow'),
  'health.ready': row('GET', '/readyz', 'public', 'allow', 'allow', 'allow', 'allow'),
  'docs.openapi': row('GET', '/api/openapi.json', 'public', 'allow', 'allow', 'allow', 'allow'),
  'auth.csrf': row('GET', '/api/auth/csrf', 'public', 'allow', 'allow', 'allow', 'allow'),
  'auth.signup': row('POST', '/api/auth/signup', 'public', 'deny', 'deny', 'deny', 'allow'),
  'auth.login': row('POST', '/api/auth/login', 'public', 'allow', 'allow', 'allow', 'allow'),
  'auth.logout': row('POST', '/api/auth/logout', 'session', 'allow', 'allow', 'allow', 'deny'),
  'auth.session': row('GET', '/api/auth/session', 'session', 'allow', 'allow', 'allow', 'deny'),
  'api_keys.list': row('GET', '/api/api-keys', 'session', 'deny', 'deny', 'own', 'deny'),
  'api_keys.create': row('POST', '/api/api-keys', 'session', 'deny', 'deny', 'allow', 'deny'),
  'api_keys.revoke': row(
    'DELETE',
    '/api/api-keys/:keyId',
    'session',
    'allow',
    'deny',
    'own',
    'deny',
  ),
  'stores.list': row('GET', '/api/stores', 'session', 'allow', 'own', 'deny', 'deny'),
  'stores.get': row('GET', '/api/stores/:storeId', 'session', 'allow', 'own', 'deny', 'deny'),
  'jobs.get': row('GET', '/api/jobs/:jobId', 'session', 'allow', 'deny', 'own', 'deny'),
  'ops.settings.list': row('GET', '/api/ops/settings', 'session', 'allow', 'deny', 'deny', 'deny'),
  'ops.settings.set': row(
    'PUT',
    '/api/ops/settings/:key',
    'session',
    'allow',
    'deny',
    'deny',
    'deny',
  ),
  'ops.audit.list': row('GET', '/api/ops/audit', 'session', 'allow', 'deny', 'deny', 'deny'),
  'ops.users.disable': row(
    'POST',
    '/api/ops/users/:userId/disable',
    'session',
    'allow',
    'deny',
    'deny',
    'deny',
  ),
  'buyer.chat_completions': row(
    'POST',
    '/v1/chat/completions',
    'api_key',
    'deny',
    'deny',
    'allow',
    'deny',
  ),
} as const satisfies Record<string, PermissionRow>;

export type Action = keyof typeof PERMISSIONS;

/**
 * Routes outside the table, each with the reason (docs/PERMISSIONS.md "표 밖 경로" lists the same).
 * The route ↔ table test fails for any other unlisted route.
 */
export const ROUTES_OUTSIDE_TABLE = {
  '/agent/v1/ws': 'agents authenticate with the protocol challenge (S02, S11), not as people',
  '/dev': 'development dashboard, registered only in development (metadata only)',
} as const;

export function accessFor(action: Action, role: Role): Access {
  return PERMISSIONS[action].access[role];
}
