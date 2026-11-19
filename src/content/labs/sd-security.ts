import type { Lab } from '../types';
import { cache, client, db, lesson, link, note, q, scene, server, service, storage, users } from '../lesson';

/* Security: authentication, authorization, encryption and secrets. */

const MODULE = 'sd-security';

export const sdSecurityLabs: Lab[] = [
  lesson({
    id: 'sd-32-authentication',
    moduleId: MODULE,
    order: 1,
    title: 'Authentication',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Proving who is calling: password storage that survives a leak, sessions versus tokens, where each is validated, and the second factor that makes a stolen password useless.',
    scenario: 'A database backup of a third-party site leaked, and attackers are trying those email-and-password pairs against Gigs at 2,000 attempts a minute. Some fans reuse passwords. The question is what Gigs stored, what it checks, and what a successful login hands out.',
    concepts: ['Password hashing', 'Credential stuffing', 'Sessions', 'JWTs', 'Multi-factor'],
    metrics: [
      { key: 'leak', label: 'Passwords readable if DB leaks' },
      { key: 'stuffing', label: 'Stuffing success/min', good: 'down' },
      { key: 'mfa', label: 'Stolen password enough?' },
      { key: 'lookup', label: 'Auth lookup per request' },
    ],
    steps: [
      {
        short: 'Storage',
        chapter: 'setup',
        title: 'Never store the password',
        body: [
          'Gigs stores a **hash** of each password made with a slow, salted algorithm (bcrypt, scrypt or Argon2): a random salt per user, and a function tuned to take about 100 ms. At login the submitted password is hashed with the same salt and compared. The database never holds anything that can be turned back into a password, and if it leaks, an attacker faces 100 ms per guess per user with no shortcut across users.',
          'A fast hash (SHA-256 alone) is not enough: a GPU tries billions a second. Slowness is the feature.',
        ],
        metrics: { leak: 'no', stuffing: null, mfa: null, lookup: null },
        scene: scene([users('f', 0, 1, 'Fan', { sub: 'password' }), server('auth', 4, 1, 'Auth service', { sub: 'argon2(salt + pw) ≈ 100 ms' }), db('db', 8, 1, 'users', { sub: 'salt, hash only' })], [link('f', 'auth', { flow: 'to', label: 'login' }), link('auth', 'db', { flow: 'both', label: 'compare hash' })]),
      },
      {
        short: 'Stuffing',
        chapter: 'problem',
        title: 'Someone else’s leak, tried against us',
        body: [
          'Attackers take 10 million email-and-password pairs from another site’s breach and try them here, 2,000 a minute across thousands of IP addresses. Hashing does nothing for this: these are real passwords, and the 3% of fans who reused them are being logged into by a stranger.',
          '**Credential stuffing** is the most common account takeover there is. The defences are rate limits per account and per IP (the rate-limiting lesson), checking submitted passwords against known-breached lists, and the thing that makes a correct password insufficient: a second factor.',
        ],
        changes: ['− 2,000 attempts/min from a botnet', '− 3% reuse → ~60 takeovers/min'],
        metrics: { stuffing: 60 },
        scene: scene([users('bot', 0, 1, 'Botnet', { sub: '10M leaked pairs', state: 'hot' }), server('auth', 4, 1, 'Auth service', { sub: '2,000 tries/min' }), db('db', 8, 1, 'users'), note('n', 8, 3, '3% reused', { sub: 'correct password, wrong person', state: 'hot' })], [link('bot', 'auth', { flow: 'to', rate: 'heavy' }), link('auth', 'db', { flow: 'both', rate: 'heavy' }), link('db', 'n', { state: 'dashed', flow: 'none' })]),
      },
      {
        short: 'MFA',
        chapter: 'technique',
        title: 'Something you know, plus something you have',
        body: [
          'After the password, Gigs asks for a six-digit code from an authenticator app (a **TOTP**, computed from a shared secret and the current time) or a tap on a hardware key (**WebAuthn**, a signature from a key that never leaves the device). The botnet has passwords; it does not have phones. Takeovers drop to zero for enrolled fans.',
          'SMS codes are better than nothing and worse than either of those: phone numbers get ported by social engineering. Push MFA to the accounts that matter (anything with a payment method) and make it the default for new ones.',
        ],
        callout: { kind: 'tip', text: 'Rate-limit and add friction *before* the second factor too: an attacker who can confirm a password is correct has learned something, even if they cannot log in.' },
        changes: ['+ TOTP / WebAuthn as a second factor', '~ Correct password alone: not enough'],
        metrics: { stuffing: 0, mfa: 'no' },
        scene: scene([users('f', 0, 1, 'Fan', { sub: 'password + code' }), server('auth', 4, 1, 'Auth service', { sub: 'verify TOTP' }), client('ph', 0, 3, 'Phone', { sub: 'authenticator app' }), users('bot', 8, 3, 'Botnet', { sub: 'no second factor', state: 'dim' })], [link('f', 'auth', { flow: 'to', label: '2 factors' }), link('ph', 'f', { flow: 'to', rate: 'light', state: 'dashed', label: '6-digit code' }), link('bot', 'auth', { flow: 'to', state: 'fail', label: 'rejected' })]),
      },
      {
        short: 'Session',
        chapter: 'technique',
        title: 'After login: a session ID in a cookie',
        body: [
          'Logging in on every request is impossible, so a successful login creates a **session**: a random ID stored in the session store with the fan’s identity and expiry, and handed to the browser as an `HttpOnly`, `Secure`, `SameSite` cookie. Each request carries the cookie; the server looks the ID up. Log out, or a suspected takeover, deletes the row and the session is dead instantly, everywhere.',
          'The cost is that lookup: one call to the session store per request. For a web app behind one company’s servers, that is cheap and the instant revocation is worth it.',
        ],
        metrics: { lookup: 'session store' },
        scene: scene([users('f', 0, 1, 'Fan', { sub: 'cookie: sid=7f3a…' }), server('w', 4, 1, 'Web fleet'), cache('s', 8, 1, 'Session store', { sub: '7f3a → fan 48213, exp' })], [link('f', 'w', { flow: 'both', label: 'cookie each request' }), link('w', 's', { flow: 'both', rate: 'heavy', label: 'lookup' })]),
      },
      {
        short: 'Token',
        chapter: 'technique',
        title: 'Or a signed token that carries its own proof',
        body: [
          'For the mobile app and partner APIs calling many services, a **JWT** is issued at login: a small JSON document (fan ID, scopes, expiry) **signed** by the auth service. Any service can verify the signature with the auth service’s public key and trust the contents without calling anyone. No lookup per request, and services stay stateless.',
          'The catch is revocation: a signed token is valid until it expires, wherever it is. So tokens are short-lived (minutes), paired with a **refresh token** that is stored and checkable, so a compromised account stops getting new access tokens within minutes rather than instantly.',
        ],
        callout: { kind: 'tradeoff', text: 'Sessions: one lookup per request, revoked instantly. Tokens: no lookup, verified anywhere, revoked only at expiry. Use sessions for the browser app, short-lived tokens between services and for APIs.' },
        changes: ['+ JWT access token, 10 min', '+ Refresh token, stored, revocable'],
        metrics: { lookup: 'none (signature)' },
        scene: scene([client('m', 0, 1, 'Mobile app', { sub: 'Bearer eyJ…' }), server('auth', 3, 3, 'Auth service', { sub: 'signs with private key' }), service('o', 5, 0, 'Orders', { sub: 'verifies with public key' }), service('c', 5, 2, 'Catalogue', { sub: 'verifies with public key' })], [link('m', 'auth', { flow: 'both', rate: 'light', label: 'login · refresh' }), link('m', 'o', { flow: 'both', label: 'token' }), link('m', 'c', { flow: 'both', label: 'token' }), link('auth', 'o', { state: 'off', flow: 'none', label: 'no call' })]),
      },
      {
        short: 'Recap',
        chapter: 'recap',
        title: 'Identity, end to end',
        body: [
          'Passwords are hashed slowly with a salt. Logins are rate-limited and checked against breach lists. A second factor makes a stolen password insufficient. A login yields a session cookie for the browser (revocable, one lookup) or a short-lived signed token for apps and services (self-contained, revoked by expiry). Every one of these is a well-trodden standard; the design decision is which to use where, never to invent one.',
        ],
        callout: { kind: 'recap', text: 'Hash, don’t store. Expect credential stuffing and defeat it with limits and a second factor. Sessions in a cookie for browsers; signed short-lived tokens for APIs and between services, with a revocable refresh token behind them.' },
        metrics: { leak: 'no', stuffing: 0, mfa: 'no', lookup: 'session or signature' },
        scene: scene([note('n1', 1, 0, 'argon2 + salt', { sub: 'storage' }), note('n2', 4, 0, 'limits + breach list', { sub: 'login' }), note('n3', 7, 0, 'TOTP / WebAuthn', { sub: 'second factor' }), note('n4', 1, 2, 'session cookie', { sub: 'browser' }), note('n5', 4, 2, 'JWT 10 min', { sub: 'apps, services' }), note('n6', 7, 2, 'refresh token', { sub: 'revocable' })]),
      },
    ],
    quiz: [
      q('q1', 'Why is a deliberately slow hash like Argon2 used for passwords?', ['It compresses the password', 'It makes each guess expensive, so a leaked table cannot be cracked quickly', 'It is required by browsers'], 1, 'Slow, salted hashing turns a leak into billions of 100 ms computations instead of a quick lookup.'),
      q('q2', 'What defends against credential stuffing when the attacker has correct, reused passwords?', ['A stronger hash', 'A second factor plus rate limiting, so a correct password alone is not enough', 'Longer session cookies'], 1, 'Hashing does not help against real passwords; MFA makes them insufficient and limits slow the attempts.'),
      q('q3', 'What is the main drawback of a signed JWT compared with a server-side session?', ['It must be looked up on every request', 'It cannot be revoked before it expires', 'It cannot carry an expiry'], 1, 'A JWT is trusted on its signature alone, so the only way to invalidate it is to keep its lifetime short.'),
    ],
  }),

  lesson({
    id: 'sd-33-authorization',
    moduleId: MODULE,
    order: 2,
    title: 'Authorization',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Knowing who is calling is not knowing what they may do: roles, resource ownership, least privilege for services, and the check that must run on every request.',
    scenario: 'A fan changed the order ID in the URL from 991 to 990 and saw someone else’s tickets. The server knew exactly who was asking. It never asked whether they were allowed to.',
    concepts: ['Broken object-level authorization', 'Roles and permissions', 'Ownership checks', 'Service-to-service identity', 'Least privilege'],
    metrics: [
      { key: 'idor', label: 'Other users’ data readable' },
      { key: 'checks', label: 'Checks per request' },
      { key: 'priv', label: 'Service privilege', good: 'down' },
    ],
    steps: [
      {
        short: 'The URL',
        chapter: 'problem',
        title: 'Authenticated is not authorised',
        body: [
          '`GET /orders/990` by a logged-in fan returns order 990. The session is valid, the token verified, the fan is exactly who they say. Order 990 belongs to somebody else. The code fetched the order by ID and never compared its owner to the caller.',
          'This is the most common serious bug in web applications: **broken object-level authorization**. Authentication answers "who are you"; authorization answers "may you do this to that", and it is a separate question on every request.',
        ],
        metrics: { idor: 'yes', checks: 0, priv: 'full' },
        scene: scene([users('f', 0, 1, 'Fan 48213', { sub: 'GET /orders/990' }), server('api', 4, 1, 'Orders API', { sub: 'fetch by id, no check', state: 'warn', tag: 'IDOR' }), db('db', 8, 1, 'orders', { sub: '990 → fan 11702' })], [link('f', 'api', { flow: 'both', label: 'someone else’s order' }), link('api', 'db', { flow: 'both' })]),
      },
      {
        short: 'Ownership',
        chapter: 'technique',
        title: 'Check the resource belongs to the caller',
        body: [
          'The fix is a line, and the discipline is that it is on every endpoint: `WHERE id = 990 AND fan_id = :caller`. Nothing comes back if the order is not theirs, and the response is 404, not 403, so the attacker does not learn that order 990 exists. Put the check in one place (a repository method that always scopes by caller) rather than remembering it in forty handlers.',
          'The same applies to writes, to list endpoints (filter by owner, never return everything and filter in the client), and to IDs that look unguessable. Random IDs are not authorization.',
        ],
        callout: { kind: 'warn', text: 'Every endpoint that takes an ID is a place this bug can live. Test it the way an attacker would: log in as A, request B’s things.' },
        changes: ['+ Ownership check in the data layer', '~ Not yours → 404'],
        metrics: { idor: 'no', checks: 1 },
        scene: scene([users('f', 0, 1, 'Fan 48213'), server('api', 4, 1, 'Orders API', { sub: 'scoped by caller' }), db('db', 8, 1, 'orders', { sub: 'WHERE id=990 AND fan_id=48213' })], [link('f', 'api', { flow: 'to', label: 'GET /orders/990' }), link('api', 'f', { flow: 'to', state: 'dashed', label: '404' }), link('api', 'db', { flow: 'both', label: '0 rows' })]),
      },
      {
        short: 'Roles',
        chapter: 'technique',
        title: 'Roles for what people do, permissions for what they may',
        body: [
          'Venue staff scan tickets; promoters edit their own events; Gigs support can refund anyone. **Role-based access control** assigns each account roles, each role a set of **permissions** (`ticket:scan`, `event:edit`, `order:refund`), and each endpoint declares the permission it needs. The check is "does the caller hold this permission for this resource", which is the ownership check again with a wider definition of "theirs".',
          'Keep permissions fine and roles few, and store the role on the account rather than in a long-lived token, so revoking a promoter’s access takes effect now.',
        ],
        changes: ['+ Roles: fan, staff, promoter, support', '+ Permissions per endpoint'],
        metrics: { checks: 2 },
        scene: scene([users('p', 0, 0, 'Promoter', { sub: 'event:edit (own)' }), users('s', 0, 2, 'Support', { sub: 'order:refund (any)' }), server('api', 4, 1, 'API', { sub: 'permission + scope check' }), db('db', 8, 1, 'roles', { sub: 'account → roles → perms' })], [link('p', 'api', { flow: 'to', label: 'PATCH /events/42' }), link('s', 'api', { flow: 'to', label: 'POST /orders/990/refund' }), link('api', 'db', { flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Services',
        chapter: 'technique',
        title: 'Services are callers too',
        body: [
          'The notifications service reads orders to send receipts. It connects with the shared database password and could, if compromised, read and change everything. Give each service its own **identity** (a certificate from the mesh, or a credential of its own) and its own **least privilege**: notifications gets a database role that can `SELECT` from orders and nothing else; it calls the payments API with a token whose scope is `receipt:read`.',
          'When notifications is breached (and plan on something being breached), the attacker gets receipts, not refunds.',
        ],
        callout: { kind: 'recap', text: 'Authorization is a check on every request: does this caller hold this permission for this resource? Scope every query by owner, declare the permission each endpoint needs, keep roles on the account, and give services identities with only the access they use.' },
        changes: ['+ Per-service identity (mTLS)', '+ Notifications: SELECT-only DB role, receipt:read scope'],
        metrics: { idor: 'no', checks: 2, priv: 'least' },
        scene: scene([service('not', 1, 1, 'Notifications', { sub: 'identity: notifications' }), db('db', 5, 0, 'orders DB', { sub: 'role: SELECT only' }), service('pay', 5, 2, 'Payments', { sub: 'scope receipt:read' }), note('br', 9, 1, 'if breached', { sub: 'can read receipts, cannot refund' })], [link('not', 'db', { flow: 'both', label: 'read only' }), link('not', 'pay', { flow: 'both', rate: 'light', label: 'scoped token' }), link('not', 'br', { state: 'dashed', flow: 'none' })]),
      },
    ],
    quiz: [
      q('q1', 'A logged-in user changes an ID in a URL and sees another user’s record. Which check was missing?', ['Password verification', 'An ownership (object-level authorization) check on the resource', 'Rate limiting'], 1, 'The caller was authenticated; the server never verified the resource belonged to them.'),
      q('q2', 'Why return 404 rather than 403 for a resource the caller does not own?', ['404 is faster', 'It does not confirm that the resource exists', '403 is deprecated'], 1, 'A 403 leaks existence; a 404 tells the attacker nothing about other users’ IDs.'),
      q('q3', 'What does least privilege mean for a service account?', ['It runs as root for reliability', 'It gets only the specific access it needs, so a breach is limited to that', 'It shares credentials with other services'], 1, 'Scoping each service’s identity to what it uses bounds the damage of a compromise.'),
    ],
  }),

  lesson({
    id: 'sd-34-encryption-and-secrets',
    moduleId: MODULE,
    order: 3,
    title: 'Encryption and Secrets',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Data on the wire, data on the disk, and the keys and passwords that must not be in the code: TLS everywhere, encryption at rest and in the application, and a secrets manager with rotation.',
    scenario: 'A contractor’s laptop was stolen with a copy of the Gigs repository on it. The repository contained the production database password, a payment API key and a signing key, in a configuration file, because that was where they had always been.',
    concepts: ['TLS and mutual TLS', 'Encryption at rest', 'Field-level encryption', 'Secrets managers', 'Key rotation'],
    metrics: [
      { key: 'transit', label: 'Encrypted in transit' },
      { key: 'rest', label: 'Encrypted at rest' },
      { key: 'incode', label: 'Secrets in code', good: 'down' },
      { key: 'rotate', label: 'Rotation' },
    ],
    steps: [
      {
        short: 'In transit',
        chapter: 'setup',
        title: 'Every connection, not just the public one',
        body: [
          'Fans reach Gigs over **TLS**: the certificate proves the server is `gigs.example`, and the traffic is encrypted and tamper-proof. Inside the data centre, the API talks to orders, orders to the database, in the clear, on the theory that the network is private. It is private until one machine on it is compromised, after which everything on it is readable.',
          'Encrypt internal traffic too, and go further: **mutual TLS**, where both ends present certificates, so the database knows it is talking to the orders service and not to whatever is squatting on its address. The service mesh from the discovery lesson does this for free.',
        ],
        metrics: { transit: 'edge only', rest: 'no', incode: 3, rotate: 'never' },
        scene: scene([users('f', 0, 1, 'Fans'), server('edge', 3, 1, 'Edge', { sub: 'TLS' }), service('o', 6, 1, 'Orders'), db('db', 9, 1, 'Database')], [link('f', 'edge', { flow: 'both', label: 'TLS ✓' }), link('edge', 'o', { flow: 'both', label: 'plain', state: 'dashed' }), link('o', 'db', { flow: 'both', label: 'plain', state: 'dashed' })]),
      },
      {
        short: 'At rest',
        chapter: 'technique',
        title: 'Disks, backups, and the fields that matter most',
        body: [
          '**Encryption at rest** at the disk or volume level protects against a stolen drive or a mis-shared backup; the database reads and writes normally, and the key lives with the platform. It does nothing against an attacker who can query the database, because the database decrypts for them.',
          'For the fields that would hurt most (payment tokens, identity documents), encrypt in the **application** with a key the database never sees. A dump of the table yields ciphertext. The cost is that those fields cannot be searched or indexed, so you design around looking them up by something else.',
        ],
        callout: { kind: 'insight', text: 'Each layer of encryption answers a different threat. Disk-level: stolen hardware and backups. Field-level: a compromised database or an over-privileged query. Neither replaces access control.' },
        changes: ['+ Volume encryption on DB and backups', '+ App-level encryption of payment tokens'],
        metrics: { transit: 'everywhere (mTLS)', rest: 'disk + fields' },
        scene: scene([service('o', 1, 1, 'Orders', { sub: 'encrypts card token' }), db('db', 5, 1, 'Database', { sub: 'ciphertext column' }), storage('bk', 9, 0, 'Backups', { sub: 'encrypted volume' }), note('dump', 9, 2, 'table dump', { sub: 'tokens unreadable' })], [link('o', 'db', { flow: 'both', label: 'mTLS' }), link('db', 'bk', { flow: 'to', rate: 'light' }), link('db', 'dump', { state: 'dashed', flow: 'none' })]),
      },
      {
        short: 'The repo',
        chapter: 'problem',
        title: 'Three secrets in a stolen laptop',
        body: [
          'The config file in the repository holds the database password, the payment API key and the token-signing key. The laptop is gone. Every copy of the repository, every CI log that printed the config, every developer machine, now has to be assumed to carry those three strings. Rotating them means finding every place they were pasted.',
          'A secret in code is a secret with an unknown number of copies. The fix is to make it impossible for code to contain one.',
        ],
        changes: ['− DB password, API key, signing key exposed', '− Unknown number of copies'],
        metrics: { incode: 3 },
        scene: scene([client('lap', 0, 1, 'Stolen laptop', { sub: 'repo clone', state: 'hot' }), note('cfg', 4, 1, 'config.yml', { sub: 'db_password · api_key · signing_key', state: 'hot', tag: 'EXPOSED' }), db('db', 8, 0, 'Database'), service('pay', 8, 2, 'Payment provider')], [link('lap', 'cfg', { state: 'dashed', flow: 'none' }), link('cfg', 'db', { flow: 'to', state: 'fail', label: 'works' }), link('cfg', 'pay', { flow: 'to', state: 'fail', label: 'works' })]),
      },
      {
        short: 'Secrets manager',
        chapter: 'technique',
        title: 'Fetch secrets at runtime, by identity',
        body: [
          'A **secrets manager** (Vault, or the cloud’s native one) holds the secrets. A service authenticates to it with its own identity (the mTLS certificate, or a platform-issued token) and receives only the secrets its policy allows, at startup or on demand, into memory and never onto disk. The repository contains the *name* of the secret and nothing else.',
          'Access is logged: which service read which secret when. That log is what you reach for after the next stolen laptop.',
        ],
        changes: ['+ Secrets manager, policy per service', '~ Code holds names, not values', '+ Access audit log'],
        metrics: { incode: 0 },
        scene: scene([service('o', 1, 1, 'Orders', { sub: 'identity: orders' }), storage('v', 5, 1, 'Secrets manager', { sub: 'policy: orders → db, payments', state: 'new' }), db('db', 9, 0, 'Database'), note('log', 9, 2, 'audit log', { sub: 'who read what, when' })], [link('o', 'v', { flow: 'both', label: 'get db_password' }), link('o', 'db', { flow: 'both' }), link('v', 'log', { flow: 'to', rate: 'light', state: 'dashed' })]),
      },
      {
        short: 'Rotate',
        chapter: 'solution',
        title: 'Change them on a schedule, and prove you can',
        body: [
          'With secrets fetched at runtime, **rotation** becomes routine: the manager issues the database a new password and the services a new credential, old ones stay valid for an overlap window, then are revoked. Many managers can issue **short-lived** database credentials per service instance, so there is no long-lived password to steal at all. Signing keys rotate with a key ID in each token, so old tokens verify against the old key until they expire.',
          'The stolen-laptop incident ends with three rotations run from a console, a check of the audit log, and no hunt through old commits.',
        ],
        callout: { kind: 'recap', text: 'TLS on every connection, mutual TLS between services. Encrypt disks and backups; encrypt the most sensitive fields in the application. No secret lives in code: services fetch them by identity from a secrets manager that logs access, and rotation is a scheduled, practised operation.' },
        metrics: { transit: 'everywhere (mTLS)', rest: 'disk + fields', incode: 0, rotate: 'scheduled + on demand' },
        scene: scene([storage('v', 1, 1, 'Secrets manager', { sub: 'rotates every 30 d' }), db('db', 5, 0, 'Database', { sub: 'new password, old valid 1 h' }), service('o', 5, 2, 'Orders', { sub: 'picks up new credential' }), note('kid', 9, 1, 'signing key v7', { sub: 'tokens carry kid; v6 verifies until expiry' })], [link('v', 'db', { flow: 'to', label: 'rotate' }), link('v', 'o', { flow: 'to', label: 'rotate' }), link('v', 'kid', { state: 'dashed', flow: 'none' })]),
      },
    ],
    quiz: [
      q('q1', 'Disk-level encryption at rest is enabled on the database. Which threat does it NOT address?', ['A stolen physical drive', 'An attacker who can run queries against the live database', 'A backup copied to the wrong bucket'], 1, 'The database decrypts transparently for anyone who can query it; field-level encryption and access control cover that.'),
      q('q2', 'Why is a secret stored in the source repository hard to rotate?', ['Git cannot store strings', 'It has been copied to every clone, CI log and machine, so you cannot know where it lives', 'Repositories are encrypted'], 1, 'Code is copied freely; a secret in it has an unknown number of copies.'),
      q('q3', 'How does a service obtain a database password from a secrets manager?', ['It reads it from a config file', 'It authenticates with its own identity and is given only the secrets its policy allows', 'It asks another service for it'], 1, 'Secrets are fetched at runtime by identity under policy, and the access is logged.'),
    ],
  }),
];

