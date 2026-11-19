import type { Lab } from '../types';
import { lb, lesson, link, note, q, region, scene, server, service, users, worker } from '../lesson';

/* Shipping: testing a distributed system, and deploying it without a maintenance window. */

const MODULE = 'sd-shipping';

export const sdShippingLabs: Lab[] = [
  lesson({
    id: 'sd-35-testing',
    moduleId: MODULE,
    order: 1,
    title: 'Testing',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'A pyramid of fast unit tests, fewer integration tests against real dependencies, contract tests between services, and the chaos experiment that tests the failure paths nobody runs.',
    scenario: 'Every service at Gigs has green unit tests. Last week a release broke checkout for an hour: orders started sending a renamed field that payments did not understand. Both test suites passed. Neither tested the conversation.',
    concepts: ['Test pyramid', 'Integration tests', 'Consumer-driven contracts', 'Test environments', 'Chaos engineering'],
    metrics: [
      { key: 'unit', label: 'Unit tests (s)' },
      { key: 'covers', label: 'Cross-service breaks caught' },
      { key: 'failPaths', label: 'Failure paths exercised' },
    ],
    steps: [
      {
        short: 'Pyramid',
        chapter: 'setup',
        title: 'Many fast tests, few slow ones',
        body: [
          'The **unit tests** run in seconds, exercise one function or class with its dependencies faked, and catch most logic bugs on every commit. Above them, fewer **integration tests** run a service against a real database and a real queue in a container, and catch the bugs that only exist where the code meets the world: a query that is wrong only on real PostgreSQL. Above those, a handful of **end-to-end** tests click through a real deployment.',
          'The shape is a pyramid because cost and flakiness grow with each layer. The failure last week was in a layer Gigs did not have.',
        ],
        metrics: { unit: 12, covers: 'no', failPaths: 'few' },
        scene: scene([note('u', 1, 2, 'unit · 4,000 · 12 s', { sub: 'fakes everything' }), note('i', 4, 1, 'integration · 120 · 4 min', { sub: 'real DB, real queue' }), note('e', 7, 0, 'end-to-end · 8 · 20 min', { sub: 'real deployment' }), note('gap', 10, 1, 'between services?', { sub: 'nothing', state: 'hot' })]),
      },
      {
        short: 'The gap',
        chapter: 'problem',
        title: 'Two green suites, one broken conversation',
        body: [
          'Orders renamed `amount_cents` to `amount` and updated its own tests. Payments still expected `amount_cents`, and its tests still passed, because they fed it the old field. In production, orders sent a request payments rejected, and checkout failed until someone read the logs.',
          'Each suite tested its service in isolation. The bug was in the **contract** between them, which neither suite owned.',
        ],
        changes: ['− orders: amount_cents → amount', '− payments: still expects amount_cents', '− Both suites green'],
        scene: scene([service('o', 1, 1, 'Orders', { sub: 'tests: green ✓' }), service('p', 7, 1, 'Payments', { sub: 'tests: green ✓' }), note('req', 4, 3, '{ "amount": 4500 }', { sub: 'rejected: amount_cents missing', state: 'hot' })], [link('o', 'p', { flow: 'to', state: 'fail', label: '400 Bad Request' }), link('o', 'req', { state: 'dashed', flow: 'none' })]),
      },
      {
        short: 'Contracts',
        chapter: 'technique',
        title: 'The consumer writes down what it expects',
        body: [
          'A **consumer-driven contract**: payments (the provider) publishes what it accepts, and orders (the consumer) records, in a test, the exact requests it sends and the responses it relies on. The contract file is shared. Payments’ build replays the consumer’s requests against the real payments service and fails if any is rejected; orders’ build fails if it starts sending something no contract covers.',
          'The rename would have failed the orders build before merge, with a message naming the field and the consumer. No deployment, no logs, no hour.',
        ],
        callout: { kind: 'tip', text: 'Contract tests are cheap: they run in the unit layer, against stubs generated from the contract. Their value is entirely in being run by both sides on every change.' },
        changes: ['+ Contract: orders → payments', '+ Both builds verify it'],
        metrics: { covers: 'yes' },
        scene: scene([service('o', 1, 1, 'Orders', { sub: 'consumer test writes contract' }), note('c', 4, 1, 'contract.json', { sub: 'requests + expected responses', state: 'new' }), service('p', 7, 1, 'Payments', { sub: 'provider build replays it' })], [link('o', 'c', { flow: 'to', label: 'publishes' }), link('c', 'p', { flow: 'to', label: 'verifies' })]),
      },
      {
        short: 'Environments',
        chapter: 'tradeoff',
        title: 'The shared staging environment that is always broken',
        body: [
          'End-to-end tests need somewhere to run. A single shared **staging** environment is the classic answer and the classic problem: six teams deploying to it, data drifting from production, and a failed test that means "someone else broke staging" as often as "my change is wrong". Teams stop trusting it.',
          'Better: **ephemeral environments** per pull request, created from the same definitions as production (the Terraform path) and torn down after; and a small set of end-to-end tests that run against production itself, with a test account, as **synthetic monitoring**. The first catches integration problems before merge; the second catches what staging never could.',
        ],
        changes: ['− One shared staging', '+ Per-PR environment, torn down after', '+ Synthetic checkout against production'],
        scene: scene([region('pr', 0, 0, 3, 1, 'PR #4821 env'), service('o1', 0, 0, 'Orders'), service('p1', 2, 0, 'Payments'), region('pr2', 0, 2, 3, 1, 'PR #4823 env'), service('o2', 0, 2, 'Orders'), service('p2', 2, 2, 'Payments'), region('prod', 6, 0, 3, 3, 'production'), server('prodo', 6, 1, 'Orders'), worker('syn', 8, 1, 'Synthetic test', { sub: 'checkout every 5 min' })], [link('o1', 'p1', { flow: 'both', rate: 'light' }), link('o2', 'p2', { flow: 'both', rate: 'light' }), link('syn', 'prodo', { flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Chaos',
        chapter: 'solution',
        title: 'Break it on purpose, during office hours',
        body: [
          'The reliability module added timeouts, breakers and failover, and none of it has run outside a unit test. **Chaos experiments** run it: kill a payments instance at 10:00 on Tuesday and watch whether the breaker opens and the fans see the "seat held" message; add 500 ms of latency to the database replica and see if read-your-writes routing still holds; fail over the database and time it.',
          'Each experiment has a hypothesis, a blast radius (one instance, 5% of traffic) and an abort switch. The point is not to cause outages but to discover, cheaply and in daylight, the ones you were going to have anyway.',
        ],
        callout: { kind: 'recap', text: 'Unit tests for logic, integration tests against real dependencies, contract tests for every conversation between services, ephemeral environments instead of a shared staging, synthetic checks against production, and chaos experiments so the failure paths have been seen to work.' },
        metrics: { unit: 12, covers: 'yes', failPaths: 'exercised weekly' },
        scene: scene([worker('ch', 1, 1, 'Chaos runner', { sub: 'Tue 10:00: kill 1 payments' }), lb('lb', 4, 1, 'Balancer'), service('p1', 7, 0, 'Payments 1', { state: 'down', sub: 'killed on purpose' }), service('p2', 7, 2, 'Payments 2', { sub: 'takes the load' }), note('h', 10, 1, 'hypothesis', { sub: 'breaker opens < 5 s, fans see held seat' })], [link('ch', 'p1', { flow: 'to', state: 'fail', label: 'kill' }), link('lb', 'p1', { state: 'fail', flow: 'none' }), link('lb', 'p2', { flow: 'both', rate: 'heavy' }), link('ch', 'h', { state: 'dashed', flow: 'none' })]),
      },
    ],
    quiz: [
      q('q1', 'Two services each have passing test suites, and a renamed field breaks the call between them. Which kind of test was missing?', ['More unit tests', 'A contract test shared by consumer and provider', 'A load test'], 1, 'Neither suite owned the conversation; a consumer-driven contract makes both builds verify it.'),
      q('q2', 'Why do teams stop trusting a single shared staging environment?', ['It is too fast', 'Other teams’ changes and drifting data make failures ambiguous', 'It cannot run end-to-end tests'], 1, 'A shared environment conflates everyone’s changes, so a red test often is not about your change.'),
      q('q3', 'What is the purpose of a chaos experiment?', ['To find out how much load the system takes', 'To exercise failure-handling paths deliberately, with a hypothesis and a limited blast radius', 'To replace integration tests'], 1, 'Chaos engineering verifies that resilience mechanisms work, in daylight, before a real incident relies on them.'),
    ],
  }),

  lesson({
    id: 'sd-36-cicd-and-deployments',
    moduleId: MODULE,
    order: 2,
    title: 'CI/CD and Deployments',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'From merge to production without a maintenance window: the pipeline, rolling and blue-green deploys, the canary that catches what tests missed, and the rollback that must be faster than the deploy.',
    scenario: 'Gigs deploys on Thursday nights by stopping the servers, copying new code, and starting them again. The site is down for eight minutes, every deploy is a risk nobody wants to take, and so deploys are rare and large, which makes them riskier.',
    concepts: ['Pipelines', 'Immutable artifacts', 'Rolling and blue-green', 'Canary releases', 'Rollback and feature flags'],
    metrics: [
      { key: 'downtime', label: 'Downtime per deploy', good: 'down' },
      { key: 'freq', label: 'Deploys/week', good: 'up' },
      { key: 'blast', label: 'Users hit by a bad deploy', unit: '%', good: 'down' },
      { key: 'restore', label: 'Time to restore', good: 'down' },
    ],
    steps: [
      {
        short: 'Thursday',
        chapter: 'problem',
        title: 'Stop, copy, start, pray',
        body: [
          'The Thursday deploy: a maintenance page, stop every web server, copy the new code, run migrations, start, and watch the error log. Eight minutes down, and if it goes wrong, another eight minutes to copy the old code back, if anyone remembers where it is.',
          'Because each deploy is scary, there are few, so each carries three weeks of changes, so each is scarier. The cycle is the problem, not any one deploy.',
        ],
        metrics: { downtime: '8 min', freq: 1, blast: 100, restore: '15 min' },
        scene: scene([users('f', 0, 1, 'Fans', { sub: 'maintenance page', state: 'warn' }), lb('lb', 3, 1, 'Balancer'), server('w1', 6, 0, 'Web 1', { state: 'down', sub: 'copying…' }), server('w2', 6, 1, 'Web 2', { state: 'down', sub: 'copying…' }), server('w3', 6, 2, 'Web 3', { state: 'down', sub: 'copying…' })], [link('f', 'lb', { flow: 'to', state: 'fail' }), link('lb', 'w1', { state: 'off', flow: 'none' }), link('lb', 'w2', { state: 'off', flow: 'none' }), link('lb', 'w3', { state: 'off', flow: 'none' })]),
      },
      {
        short: 'Pipeline',
        chapter: 'technique',
        title: 'Build once, test, promote the same artifact',
        body: [
          'A **pipeline** runs on every merge: build an **immutable artifact** (a container image tagged with the commit), run the unit and contract tests, start an ephemeral environment and run integration tests, then promote that exact image to production. Nothing is built on a server; nothing differs between what was tested and what runs.',
          'Because the pipeline is automatic and the artifact is small (one day’s changes, not three weeks’), deploying stops being an event and becomes what happens after a merge.',
        ],
        callout: { kind: 'insight', text: 'The image that passed the tests is the image that ships. Rebuilding for production, or configuring servers by hand, reintroduces the difference that tests were supposed to remove.' },
        changes: ['+ Pipeline: build → test → promote', '+ Artifact: image tagged by commit'],
        metrics: { freq: 10 },
        scene: scene([note('m', 0, 1, 'merge', { sub: 'commit 3f9c2a' }), worker('b', 3, 1, 'Build', { sub: 'image:3f9c2a' }), worker('t', 6, 1, 'Test', { sub: 'unit · contract · integration' }), worker('d', 9, 1, 'Deploy', { sub: 'same image' })], [link('m', 'b', { flow: 'to' }), link('b', 't', { flow: 'to' }), link('t', 'd', { flow: 'to' })]),
      },
      {
        short: 'Rolling',
        chapter: 'technique',
        title: 'Replace servers one at a time',
        body: [
          'A **rolling deploy** takes one server out of the balancer, starts the new version on it, waits for its health check to pass, puts it back, and moves to the next. Fans never see a maintenance page; at worst the fleet runs at two-thirds capacity for a minute. Old and new versions serve side by side during the roll, which means the new version must accept the old version’s sessions and the database schema must work for both.',
          'That compatibility requirement is the real discipline of zero-downtime deploys: every change is two changes, "add the new thing" and, later, "remove the old thing".',
        ],
        changes: ['~ One server at a time, health-checked', '~ Downtime 8 min → 0', '+ Schema changes must be backward compatible'],
        metrics: { downtime: '0' },
        scene: scene([users('f', 0, 1, 'Fans', { sub: 'no interruption' }), lb('lb', 3, 1, 'Balancer'), server('w1', 6, 0, 'Web 1', { sub: 'v2 ✓', state: 'new' }), server('w2', 6, 1, 'Web 2', { sub: 'v2 starting…', state: 'dim' }), server('w3', 6, 2, 'Web 3', { sub: 'v1' })], [link('f', 'lb', { flow: 'both' }), link('lb', 'w1', { flow: 'both' }), link('lb', 'w2', { state: 'off', flow: 'none', label: 'draining' }), link('lb', 'w3', { flow: 'both' })]),
      },
      {
        short: 'Blue-green',
        chapter: 'technique',
        title: 'Two fleets, flip the switch',
        body: [
          'A **blue-green deploy** keeps two complete fleets. Blue serves production; green is idle. Deploy v2 to green, test it directly, then switch the balancer from blue to green in one move. Something wrong? Switch back: rollback in seconds, to a fleet that is still running the last good version.',
          'It costs double the servers (or a second fleet spun up just for the deploy) and still needs the same schema compatibility, because you may switch back after v2 has written data.',
        ],
        callout: { kind: 'tradeoff', text: 'Rolling: no extra capacity, mixed versions during the roll, slower rollback. Blue-green: instant switch and rollback, double the fleet during the deploy.' },
        changes: ['+ Green fleet with v2', '~ Switch in one move; rollback = switch back'],
        metrics: { restore: '30 s' },
        scene: scene([users('f', 0, 1, 'Fans'), lb('lb', 3, 1, 'Balancer', { sub: '→ green' }), region('blue', 6, 0, 3, 1, 'blue · v1'), server('b1', 6, 0, 'Web'), server('b2', 8, 0, 'Web'), region('green', 6, 2, 3, 1, 'green · v2'), server('g1', 6, 2, 'Web', { state: 'new' }), server('g2', 8, 2, 'Web', { state: 'new' })], [link('f', 'lb', { flow: 'both' }), link('lb', 'b1', { state: 'off', flow: 'none', label: 'standby' }), link('lb', 'g1', { flow: 'both', rate: 'heavy' }), link('lb', 'g2', { flow: 'both', rate: 'heavy' })]),
      },
      {
        short: 'Canary',
        chapter: 'technique',
        title: 'Give the new version 2% of the traffic first',
        body: [
          'Tests passed; the deploy worked; and v2 has a bug that only shows under real traffic. A **canary** sends 2% of requests to one v2 instance and compares its error rate and latency with the v1 fleet, automatically. Healthy for ten minutes? Raise to 10%, then 50%, then all. Worse than baseline? Pull the canary, and 98% of fans never saw it.',
          'Canaries turn the observability module into a deployment gate: the metrics decide whether the rollout continues.',
        ],
        changes: ['+ 2% canary, compared against baseline', '~ Promote in steps or abort automatically'],
        metrics: { blast: 2 },
        scene: scene([users('f', 0, 1, 'Fans'), lb('lb', 3, 1, 'Balancer', { sub: '98% / 2%' }), server('v1', 6, 0, 'v1 fleet', { sub: 'errors 0.1%' }), server('c', 6, 2, 'v2 canary', { sub: 'errors 0.9%', state: 'warn', tag: 'ABORT' }), note('cmp', 9, 1, 'compare', { sub: 'canary worse → roll back' })], [link('f', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'v1', { flow: 'both', rate: 'heavy' }), link('lb', 'c', { flow: 'both', rate: 'light' }), link('c', 'cmp', { state: 'dashed', flow: 'none' }), link('v1', 'cmp', { state: 'dashed', flow: 'none' })]),
      },
      {
        short: 'Rollback',
        chapter: 'solution',
        title: 'Undo must be faster than do',
        body: [
          'Whatever the strategy, the question to answer before deploying is "how do I undo this in under a minute?" Blue-green: switch back. Rolling: roll the previous image, which is still in the registry. For risky changes, a **feature flag** separates deploy from release: the code ships dark, is turned on for staff, then for 5% of fans, and is turned off by a setting if it misbehaves, with no deploy at all.',
          'Database migrations are the part that cannot be flipped: expand first (add the column, write both), deploy, then contract (drop the old column) in a later release once nothing reads it.',
        ],
        callout: { kind: 'recap', text: 'Build an immutable artifact once and promote it through tests. Deploy rolling or blue-green with backward-compatible schemas, gate the rollout on a canary’s metrics, and keep rollback under a minute: previous image, switch back, or a feature flag turned off.' },
        metrics: { downtime: '0', freq: 15, blast: 2, restore: '30 s' },
        scene: scene([note('r1', 1, 0, 'blue-green', { sub: 'switch back' }), note('r2', 4, 0, 'rolling', { sub: 'roll previous image' }), note('r3', 7, 0, 'feature flag', { sub: 'turn off, no deploy' }), note('r4', 10, 0, 'schema', { sub: 'expand → deploy → contract' })]),
      },
    ],
    quiz: [
      q('q1', 'Why should the artifact tested in the pipeline be the exact one deployed to production?', ['It saves disk space', 'Rebuilding or hand-configuring reintroduces differences the tests did not cover', 'Production cannot build images'], 1, 'An immutable artifact promoted through environments guarantees what was tested is what runs.'),
      q('q2', 'During a rolling deploy, old and new versions serve at the same time. What does that require?', ['Twice the servers', 'Backward-compatible schema and session changes', 'A maintenance page'], 1, 'Mixed versions must share the database and sessions, so every change must work for both versions.'),
      q('q3', 'What does a canary release add that a passing test suite does not?', ['Faster builds', 'A check of the new version against real traffic, limited to a small share of users', 'Automatic schema migrations'], 1, 'Canaries compare live metrics for a small slice of traffic and abort before most users are affected.'),
    ],
  }),
];
