import type { Lab } from '../types';
import { db, lesson, link, note, q, queue, region, scene, server, service, storage, users, worker } from '../lesson';

/* Architecture: monolith vs microservices, service discovery, sagas, batch and stream processing. */

const MODULE = 'sd-architecture';

export const sdArchitectureLabs: Lab[] = [
  lesson({
    id: 'sd-28-monolith-vs-microservices',
    moduleId: MODULE,
    order: 1,
    title: 'Monolith vs Microservices',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'One deployable or many: what a split buys in independence, what it costs in network calls and operations, and the seam to cut first.',
    scenario: 'Gigs is one application: catalogue, orders, payments, notifications and reporting in a single codebase, deployed together. Four teams now work on it. Deploys are weekly, scary and all-or-nothing. Someone has suggested microservices.',
    concepts: ['Modular monolith', 'Independent deployment', 'Network boundaries', 'Operational cost', 'Extracting a service'],
    metrics: [
      { key: 'deploys', label: 'Deploys/week', good: 'up' },
      { key: 'blast', label: 'Blast radius of a bad deploy', good: 'down' },
      { key: 'hops', label: 'Network hops/checkout', good: 'down' },
      { key: 'ops', label: 'Things to run' },
    ],
    steps: [
      {
        short: 'Monolith',
        chapter: 'setup',
        title: 'One codebase, one process, one database',
        body: [
          'Everything is one deployable. A checkout calls the inventory module, the payments module and the notifications module as plain function calls in the same process, in one database transaction. It is fast, consistent and easy to run: one thing to deploy, one thing to monitor, one database to back up.',
          'With four teams, the costs show up as coordination. A bug in reporting blocks the catalogue team’s release. A memory leak in notifications restarts the whole process. Everyone merges to one main branch and waits for one weekly deploy window.',
        ],
        metrics: { deploys: 1, blast: 'everything', hops: 0, ops: 1 },
        scene: scene([users('f', 0, 1, 'Fans'), region('mono', 2, 0, 5, 3, 'gigs (one process)'), server('cat', 2, 0, 'Catalogue'), server('ord', 4, 0, 'Orders'), server('pay', 6, 0, 'Payments'), server('not', 2, 2, 'Notifications'), server('rep', 4, 2, 'Reporting'), db('db', 10, 1, 'One database')], [link('f', 'cat', { flow: 'both' }), link('ord', 'db', { flow: 'both' }), link('rep', 'db', { flow: 'both', rate: 'heavy' })]),
      },
      {
        short: 'Modules first',
        chapter: 'technique',
        title: 'Draw the boundaries before you cut them',
        body: [
          'The cheapest improvement keeps one deployable and enforces **module boundaries** inside it: orders may call inventory only through a defined interface, reporting may read only its own tables, and the build fails when a module reaches into another’s internals. Teams own modules. The deploy is still one unit, but the code no longer is.',
          'A **modular monolith** gets most of the organisational benefit of services with none of the network. It is also the only sane precursor to splitting: a boundary that cannot be enforced in one process will not survive being a network.',
        ],
        callout: { kind: 'insight', text: 'Microservices do not create boundaries; they make the ones you have expensive to cross. If the modules are tangled, splitting them makes a distributed tangle.' },
        changes: ['+ Module interfaces enforced in the build', '+ Per-module ownership and tests', '~ Still one deploy'],
        metrics: { deploys: 3, blast: 'everything' },
        scene: scene([region('mono', 1, 0, 5, 3, 'modular monolith'), server('cat', 1, 0, 'Catalogue', { sub: 'team A' }), server('ord', 3, 0, 'Orders', { sub: 'team B' }), server('pay', 5, 0, 'Payments', { sub: 'team C' }), server('not', 1, 2, 'Notifications', { sub: 'team D' }), server('rep', 3, 2, 'Reporting', { sub: 'team D' }), note('rule', 8, 1, 'only via interfaces', { sub: 'build fails otherwise' })], [link('ord', 'pay', { flow: 'to', label: 'interface' }), link('ord', 'cat', { flow: 'to', label: 'interface' })]),
      },
      {
        short: 'Extract one',
        chapter: 'technique',
        title: 'Cut the seam that hurts most',
        body: [
          'Notifications restarts the process twice a week and has nothing to do with checkout. It becomes the first **service**: its own process, its own deploys, its own small database for templates and delivery logs, fed by events from the orders topic. The notifications team deploys daily without asking anyone. When it leaks memory, only notifications restarts.',
          'Pick the first extraction by pain and by independence: something with a clear interface, its own data, and a different scaling or release profile from the rest.',
        ],
        changes: ['+ Notifications as a service with its own DB', '~ Fed by OrderPaid events', '~ Its crashes stay its own'],
        metrics: { deploys: 8, blast: 'all but notifications', hops: 0, ops: 2 },
        scene: scene([region('mono', 0, 0, 5, 1, 'monolith'), server('cat', 0, 0, 'Catalogue'), server('ord', 2, 0, 'Orders'), server('pay', 4, 0, 'Payments'), queue('t', 6, 1, 'topic: orders'), service('not', 8, 1, 'Notifications', { sub: 'own deploys', state: 'new' }), db('ndb', 11, 1, 'templates DB')], [link('ord', 't', { flow: 'to', rate: 'light' }), link('t', 'not', { flow: 'to', rate: 'light' }), link('not', 'ndb', { flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Costs',
        chapter: 'tradeoff',
        title: 'What a network boundary costs',
        body: [
          'Suppose everything is split: checkout is now five network calls where it was five function calls. Each can time out, be slow, or return a version the caller did not expect, so every one needs the timeouts, retries and breakers from the reliability module. The transaction that spanned inventory and payments cannot exist across two databases; it becomes a saga (next lesson but one). And there are five things to build, deploy, monitor, secure and wake up for.',
          'Microservices trade a coordination problem between people for a coordination problem between machines. That is a good trade for a large organisation and a bad one for a small team.',
        ],
        callout: { kind: 'warn', text: 'Count the humans. Below a few teams, a modular monolith is nearly always the right answer; the operational cost of many services is paid in engineers who are not building features.' },
        changes: ['− 0 → 5 network hops per checkout', '− Cross-service transaction becomes a saga', '− 6 things to run, monitor, secure'],
        metrics: { deploys: 25, blast: 'one service', hops: 5, ops: 6 },
        scene: scene([users('f', 0, 1, 'Fans'), service('api', 2, 1, 'API'), service('cat', 5, 0, 'Catalogue'), service('ord', 5, 1, 'Orders'), service('inv', 5, 2, 'Inventory'), service('pay', 8, 1, 'Payments'), service('not', 8, 2, 'Notifications'), note('n', 8, 3, 'timeouts, retries, breakers', { sub: 'on every arrow' })], [link('f', 'api', { flow: 'both' }), link('api', 'cat', { flow: 'both' }), link('api', 'ord', { flow: 'both' }), link('ord', 'inv', { flow: 'both' }), link('ord', 'pay', { flow: 'both' }), link('ord', 'not', { flow: 'to', rate: 'light' })]),
      },
      {
        short: 'Where to land',
        chapter: 'recap',
        title: 'A few services, each for a reason',
        body: [
          'Gigs lands at a modular monolith for the catalogue, orders and inventory (one transaction, one team’s worth of coupling) plus three services with clear reasons: notifications (isolation and release cadence), payments (security boundary and compliance), and reporting (very different load, read replicas of its own). Checkout makes one network call, to payments, and that call has a breaker.',
          'The question is never "monolith or microservices". It is "where do the boundaries go, and which of them need to be a network".',
        ],
        callout: { kind: 'recap', text: 'Start with enforced modules in one deployable. Extract a service when it has its own data, a clear interface, and a different release, scaling or security profile. Every network boundary adds failure modes, operational cost and the loss of local transactions.' },
        metrics: { deploys: 15, blast: 'one unit', hops: 1, ops: 4 },
        scene: scene([users('f', 0, 1, 'Fans'), region('core', 2, 0, 5, 1, 'core monolith'), server('cat', 2, 0, 'Catalogue'), server('ord', 4, 0, 'Orders'), server('inv', 6, 0, 'Inventory'), service('pay', 4, 2, 'Payments', { sub: 'compliance boundary' }), service('not', 9, 0, 'Notifications', { sub: 'isolation' }), service('rep', 9, 2, 'Reporting', { sub: 'own replicas' })], [link('f', 'cat', { flow: 'both' }), link('ord', 'pay', { flow: 'both', label: 'breaker' }), link('ord', 'not', { flow: 'to', rate: 'light', label: 'events' }), link('ord', 'rep', { flow: 'to', rate: 'light', label: 'events' })]),
      },
    ],
    quiz: [
      q('q1', 'Two teams keep blocking each other’s releases in one codebase. What is the cheapest first step?', ['Split into microservices immediately', 'Enforce module boundaries inside the one deployable', 'Add more reviewers'], 1, 'A modular monolith restores ownership and isolation in code without adding a network.'),
      q('q2', 'Which module is the best first candidate to extract as a service?', ['The one most tightly coupled to the database transaction', 'One with its own data, a clear interface and a different release or scaling profile', 'The largest one'], 1, 'Independence makes the split cheap and worthwhile; coupling makes it expensive and risky.'),
      q('q3', 'What do you lose when a single-process transaction is split across two services?', ['Logging', 'Atomicity across the two operations, which must be rebuilt with a saga', 'The ability to retry'], 1, 'Two databases cannot share a transaction; cross-service consistency needs explicit compensation.'),
    ],
  }),

  lesson({
    id: 'sd-29-service-discovery',
    moduleId: MODULE,
    order: 2,
    title: 'Service Discovery',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'When servers come and go every minute, callers cannot hold a list of addresses: registries, health, DNS and the sidecar that hides it all.',
    scenario: 'The orders service calls payments at a hard-coded list of three IP addresses. Payments autoscaled to seven servers last week, and one of the original three was replaced. Orders is sending a third of its traffic to a dead address and ignoring four live ones.',
    concepts: ['Registries', 'Health-aware lookup', 'DNS-based discovery', 'Client-side vs server-side', 'Service mesh'],
    metrics: [
      { key: 'known', label: 'Live instances known', good: 'up' },
      { key: 'dead', label: 'Calls to dead addresses/s', good: 'down' },
      { key: 'config', label: 'Config changes/week', good: 'down' },
    ],
    steps: [
      {
        short: 'Hard-coded',
        chapter: 'problem',
        title: 'The list in the config file',
        body: [
          'Orders has `payments = 10.0.3.11, 10.0.3.12, 10.0.3.13` in its configuration. That was true in March. Payments now runs seven instances, scaled by load, replaced on every deploy, each with a new address. Orders knows two live ones and one that was decommissioned on Tuesday.',
          'In a fleet that changes by the minute, any static list is wrong within the hour. The list has to come from somewhere that knows.',
        ],
        metrics: { known: 2, dead: 170, config: 4 },
        scene: scene([service('o', 1, 1, 'Orders', { sub: 'config: 3 addresses', state: 'warn' }), service('p1', 6, 0, '10.0.3.11', { sub: 'live' }), service('p2', 6, 1, '10.0.3.12', { sub: 'live' }), service('p3', 6, 2, '10.0.3.13', { state: 'down', sub: 'replaced Tuesday' }), service('p4', 9, 0, '10.0.3.40–43', { sub: '4 live, unknown', state: 'dim' })], [link('o', 'p1', { flow: 'both' }), link('o', 'p2', { flow: 'both' }), link('o', 'p3', { flow: 'to', state: 'fail' }), link('o', 'p4', { state: 'off', flow: 'none' })]),
      },
      {
        short: 'Registry',
        chapter: 'technique',
        title: 'Instances announce themselves',
        body: [
          'A **service registry** (Consul, etcd, Eureka, or the one built into Kubernetes) keeps the live list. Each payments instance registers on startup (`payments @ 10.0.3.40:8443`) and sends a heartbeat; miss a few and the entry is removed. Orders asks the registry "who is payments?" and gets the seven live addresses, refreshed every few seconds.',
          'The registry is a small consensus cluster (the consensus lesson), because a registry that forks would send half the callers to a stale list.',
        ],
        callout: { kind: 'tip', text: 'Registration should be done by the platform (the scheduler that started the instance), not by the application. An app that forgets to deregister on crash leaves a dead entry; a platform that killed it never forgets.' },
        changes: ['+ Registry with heartbeats', '~ Orders resolves "payments" every 5 s'],
        metrics: { known: 7, dead: 0, config: 0 },
        scene: scene([service('o', 1, 1, 'Orders', { sub: 'asks every 5 s' }), db('reg', 5, 1, 'Registry', { sub: 'payments: 7 live', state: 'new' }), region('pay', 9, 0, 1, 3, 'payments ×7'), service('p1', 9, 0, '10.0.3.40'), service('p2', 9, 1, '10.0.3.41'), service('p3', 9, 2, '… 46')], [link('o', 'reg', { flow: 'both', rate: 'light', label: 'who is payments?' }), link('p1', 'reg', { flow: 'to', rate: 'light', label: 'heartbeat' }), link('p2', 'reg', { flow: 'to', rate: 'light' }), link('p3', 'reg', { flow: 'to', rate: 'light' }), link('o', 'p1', { flow: 'both' }), link('o', 'p2', { flow: 'both' })]),
      },
      {
        short: 'Client or server',
        chapter: 'tradeoff',
        title: 'Who does the lookup and the balancing?',
        body: [
          '**Client-side discovery**: orders fetches the list and picks an instance itself, with its own round robin and its own health view. No extra hop, but every language and every service needs the same smart client. **Server-side discovery**: orders calls a stable name (`payments.internal`), and a load balancer or proxy that watches the registry does the picking. Dumb clients, one extra hop, one place to add retries and metrics.',
          'DNS can be the registry’s face: `payments.internal` resolves to the live addresses with a short TTL. Simple, universal, and only as fresh as the TTL and the client’s DNS cache allow.',
        ],
        scene: scene([note('cs', 1, 0, 'client-side', { sub: 'smart client, no hop' }), service('o1', 1, 1, 'Orders'), service('p1', 4, 1, 'Payments'), note('ss', 7, 0, 'server-side', { sub: 'dumb client, one hop' }), service('o2', 7, 1, 'Orders'), server('px', 9, 1, 'Proxy / LB'), service('p2', 11, 1, 'Payments')], [link('o1', 'p1', { flow: 'both', label: 'picks itself' }), link('o2', 'px', { flow: 'both', label: 'payments.internal' }), link('px', 'p2', { flow: 'both' })]),
      },
      {
        short: 'Sidecar',
        chapter: 'technique',
        title: 'A proxy next to every instance',
        body: [
          'A **service mesh** puts a small proxy (a **sidecar**) beside every instance. Orders talks to `localhost`; the sidecar looks up payments, balances, retries, times out, encrypts the connection with a certificate, and reports metrics and traces, all without a line of application code. The control plane pushes registry changes and policies to every sidecar.',
          'The mesh makes the reliability module’s patterns uniform across dozens of services written by different teams. It also adds a hop, a few milliseconds, and a significant system to operate; it earns its place at a scale most teams never reach.',
        ],
        callout: { kind: 'recap', text: 'Static address lists are wrong within the hour. A registry fed by heartbeats (or by the platform) holds the live list; clients resolve a name through a smart client, a proxy, or DNS. A service mesh moves discovery, balancing, retries and mutual TLS into sidecars.' },
        metrics: { known: 7, dead: 0, config: 0 },
        scene: scene([region('oi', 0, 0, 3, 1, 'orders instance'), service('o', 0, 0, 'Orders app'), server('so', 2, 0, 'sidecar'), region('pi', 6, 0, 3, 1, 'payments instance'), server('sp', 6, 0, 'sidecar'), service('p', 8, 0, 'Payments app'), db('cp', 4, 2, 'Control plane', { sub: 'registry + policy' })], [link('o', 'so', { flow: 'both', label: 'localhost' }), link('so', 'sp', { flow: 'both', label: 'mTLS, retries' }), link('sp', 'p', { flow: 'both' }), link('cp', 'so', { flow: 'to', rate: 'light', state: 'dashed' }), link('cp', 'sp', { flow: 'to', rate: 'light', state: 'dashed' })]),
      },
    ],
    quiz: [
      q('q1', 'Why does a hard-coded list of dependency addresses fail in an autoscaled fleet?', ['Lists cannot hold more than a few addresses', 'Instances are added and replaced constantly, so the list is stale within minutes', 'IP addresses are secret'], 1, 'Autoscaling and deploys change the set of live addresses continuously.'),
      q('q2', 'How does a registry learn that an instance has died?', ['The instance sends a goodbye message', 'Missed heartbeats, or the platform that killed it deregisters it', 'The callers report failures'], 1, 'A crashed process cannot deregister itself; heartbeats and platform-driven registration cover that.'),
      q('q3', 'What is a sidecar in a service mesh?', ['A backup instance of the service', 'A proxy next to each instance that handles discovery, balancing, retries and encryption', 'A second database'], 1, 'The sidecar takes network concerns out of application code so they are uniform across services.'),
    ],
  }),

  lesson({
    id: 'sd-30-sagas',
    moduleId: MODULE,
    order: 3,
    title: 'Sagas and Distributed Transactions',
    difficulty: 'Advanced',
    estimatedMinutes: 12,
    description: 'When "reserve the seat and charge the card" spans two services with two databases, there is no transaction to wrap them: compensations, orchestration, and the outbox that makes it reliable.',
    scenario: 'Inventory and payments are separate services now. A checkout reserves a seat in one and charges a card in the other. Last night the charge succeeded and the reservation write failed on a timeout. A fan paid for a seat they do not have.',
    concepts: ['No cross-service transactions', 'Compensating actions', 'Choreography vs orchestration', 'Two-phase commit', 'Transactional outbox'],
    metrics: [
      { key: 'paidNoSeat', label: 'Paid without seat', good: 'down' },
      { key: 'seatNoPay', label: 'Seat without payment', good: 'down' },
      { key: 'coord', label: 'Coordination' },
    ],
    steps: [
      {
        short: 'Two databases',
        chapter: 'problem',
        title: 'The transaction that cannot exist',
        body: [
          'Inside the monolith, reserve-and-charge was one transaction: both or neither. Now inventory has its database and payments has its own. Orders calls inventory (reserved), then payments (charged), and the network between the two calls is where things go wrong: the charge succeeds and the final "confirm reservation" write times out. Each database is consistent; the business is not.',
          'There is no lock that spans two databases owned by two services. Something else has to guarantee the outcome.',
        ],
        metrics: { paidNoSeat: 1, seatNoPay: 0, coord: 'none' },
        scene: scene([service('o', 1, 1, 'Orders'), service('inv', 5, 0, 'Inventory', { sub: 'reserve: timeout', state: 'warn' }), db('idb', 9, 0, 'inventory DB'), service('pay', 5, 2, 'Payments', { sub: 'charge: ok' }), db('pdb', 9, 2, 'payments DB')], [link('o', 'inv', { flow: 'to', state: 'fail', label: 'confirm → timeout' }), link('inv', 'idb', { flow: 'both' }), link('o', 'pay', { flow: 'to', label: 'charged ✓' }), link('pay', 'pdb', { flow: 'both' })]),
      },
      {
        short: '2PC',
        chapter: 'technique',
        title: 'Two-phase commit: ask everyone, then tell everyone',
        body: [
          'The classic answer is **two-phase commit**: a coordinator asks each database to *prepare* (do everything but commit, and promise you can), and only when all say yes does it tell them all to *commit*. If any says no, all roll back.',
          'It works, and it is rarely used across services. Prepared transactions hold locks while waiting for the coordinator; if the coordinator crashes, every participant sits locked until it returns. It couples availability of all participants into one, and most service databases, queues and third-party APIs (the card network) do not support it at all.',
        ],
        callout: { kind: 'warn', text: 'Two-phase commit trades availability for atomicity. Across services you own and a payment provider you do not, you usually cannot make that trade even if you wanted to.' },
        scene: scene([server('c', 1, 1, 'Coordinator'), db('idb', 6, 0, 'inventory DB', { sub: 'prepared, locked' }), db('pdb', 6, 2, 'payments DB', { sub: 'prepared, locked' }), note('n', 10, 1, 'coordinator crashes?', { sub: 'both stay locked' })], [link('c', 'idb', { flow: 'both', label: '1. prepare · 2. commit' }), link('c', 'pdb', { flow: 'both', label: '1. prepare · 2. commit' }), link('c', 'n', { state: 'dashed', flow: 'none' })]),
      },
      {
        short: 'Saga',
        chapter: 'technique',
        title: 'A sequence of local transactions, each with an undo',
        body: [
          'A **saga** gives up on atomicity and keeps the outcome: a chain of local transactions, each committed on its own, and for each a **compensating action** that undoes it. Reserve the seat (undo: release it). Charge the card (undo: refund). Confirm the order. If step two fails, run the undo for step one. If step three fails, refund and release.',
          'The system passes through states that a transaction would never show (seat reserved, not yet paid), so each step must be designed to be seen mid-way, and every compensation must be idempotent, because it will be retried.',
        ],
        changes: ['+ Each step: a local commit + a compensation', '~ Failure after charge → refund, release'],
        metrics: { paidNoSeat: 0, seatNoPay: 0, coord: 'saga' },
        scene: scene([note('s1', 1, 0, '1. reserve seat', { sub: 'undo: release' }), note('s2', 4, 0, '2. charge card', { sub: 'undo: refund' }), note('s3', 7, 0, '3. confirm order', { sub: 'undo: cancel' }), note('f', 4, 2, 'step 3 fails', { sub: '→ refund, then release', state: 'hot' })], [link('s1', 's2', { flow: 'to' }), link('s2', 's3', { flow: 'to', state: 'fail' }), link('s3', 'f', { state: 'dashed', flow: 'to', rate: 'light' }), link('f', 's1', { state: 'dashed', flow: 'to', rate: 'light', label: 'compensate' })]),
      },
      {
        short: 'Who drives',
        chapter: 'tradeoff',
        title: 'Choreography or orchestration',
        body: [
          'In **choreography**, each service reacts to events: inventory sees `OrderCreated` and reserves, emits `SeatReserved`; payments sees that and charges, emits `PaymentTaken`; and so on, with failure events triggering compensations. No central brain, loose coupling, and after six steps nobody can say what the overall flow is or where a stuck order is.',
          'In **orchestration**, a saga coordinator (a small state machine in the orders service) calls each step in turn, records where it is, and runs the compensations on failure. One place to read the flow, one place to find a stuck order, and one component that must itself be durable.',
        ],
        callout: { kind: 'tradeoff', text: 'Choreography for two or three steps between services that already talk in events. Orchestration once the flow has branches, timeouts and more than a handful of steps; the visibility pays for the coupling.' },
        scene: scene([note('ch', 1, 0, 'choreography', { sub: 'events, no centre' }), service('a1', 1, 1, 'Inventory'), service('a2', 3, 1, 'Payments'), service('a3', 5, 1, 'Notify'), note('or', 8, 0, 'orchestration', { sub: 'one state machine' }), server('sc', 9, 1, 'Saga coordinator', { sub: 'step 2 of 3' }), service('b1', 8, 3, 'Inventory'), service('b2', 10, 3, 'Payments')], [link('a1', 'a2', { flow: 'to', label: 'SeatReserved' }), link('a2', 'a3', { flow: 'to', label: 'PaymentTaken' }), link('sc', 'b1', { flow: 'both' }), link('sc', 'b2', { flow: 'both' })]),
      },
      {
        short: 'Outbox',
        chapter: 'solution',
        title: 'Write the event in the same transaction as the data',
        body: [
          'One more gap: orders commits the order row and then publishes `OrderCreated`. If it crashes between the two, the saga never starts. The **transactional outbox** fixes it: the event is written to an `outbox` table in the same local transaction as the order. A relay process reads the outbox and publishes to the topic, marking rows sent. Now the event exists if and only if the order does, and the relay retries until the broker has it.',
          'Every reliable saga rests on this: local transactions that include their own outgoing messages, delivered at least once, consumed idempotently.',
        ],
        callout: { kind: 'recap', text: 'No transaction spans services. Two-phase commit locks everyone to a coordinator and rarely fits. A saga is local transactions with compensations, driven by events (choreography) or a coordinator (orchestration). The outbox pattern makes "commit and publish" atomic.' },
        metrics: { paidNoSeat: 0, seatNoPay: 0, coord: 'orchestrated saga + outbox' },
        scene: scene([service('o', 1, 1, 'Orders'), db('odb', 4, 0, 'orders table'), db('ob', 4, 2, 'outbox table', { sub: 'same transaction', state: 'new' }), worker('relay', 7, 2, 'Relay', { sub: 'reads, publishes, marks' }), queue('t', 10, 2, 'topic: orders')], [link('o', 'odb', { flow: 'to', label: 'INSERT order' }), link('o', 'ob', { flow: 'to', label: 'INSERT event' }), link('ob', 'relay', { flow: 'to', rate: 'light' }), link('relay', 't', { flow: 'to', rate: 'light', label: 'at least once' })]),
      },
    ],
    quiz: [
      q('q1', 'Why is two-phase commit rarely used across microservices?', ['It is too slow to code', 'Participants hold locks while waiting on a coordinator, coupling their availability, and many systems cannot take part', 'It does not guarantee atomicity'], 1, 'Prepared transactions block on the coordinator, and queues, third-party APIs and many databases do not support the protocol.'),
      q('q2', 'In a saga, what is a compensating action?', ['A retry of the failed step', 'A step that undoes the effect of an earlier committed step', 'A rollback of the whole database'], 1, 'Each local transaction has already committed, so failure is handled by explicitly reversing earlier steps.'),
      q('q3', 'What problem does the transactional outbox solve?', ['Slow event brokers', 'A crash between committing data and publishing the event about it, which would leave the saga unstarted', 'Duplicate events'], 1, 'Writing the event in the same transaction as the data guarantees both exist together; a relay then publishes it.'),
    ],
  }),

  lesson({
    id: 'sd-31-batch-and-stream',
    moduleId: MODULE,
    order: 4,
    title: 'Batch and Stream Processing',
    difficulty: 'Advanced',
    estimatedMinutes: 12,
    description: 'Yesterday’s numbers overnight, or this minute’s numbers now: batch jobs over stored data, stream processors over events as they happen, and the windows, lateness and reprocessing that come with each.',
    scenario: 'The venue wants "tickets scanned in the last five minutes" on a screen at the door, and finance wants exact daily sales. Both are the same events (orders, scans) computed over different windows at different speeds.',
    concepts: ['Batch jobs', 'Stream processing', 'Windows', 'Late events and watermarks', 'Lambda and kappa'],
    metrics: [
      { key: 'fresh', label: 'Freshness', good: 'down' },
      { key: 'exact', label: 'Exactness' },
      { key: 'reproc', label: 'Reprocess a day' },
    ],
    steps: [
      {
        short: 'Batch',
        chapter: 'setup',
        title: 'Once a night, over everything',
        body: [
          'A **batch** job runs at 02:00: read every order from yesterday out of the database (or the event log), group by venue and price band, write a sales report. It takes forty minutes, it is exact, and if the logic was wrong it is re-run and the report is replaced. Finance is happy.',
          'Batch is the simple, robust shape: bounded input, a complete answer, easy to re-run. Its only flaw is that the answer is about yesterday.',
        ],
        metrics: { fresh: '24 h', exact: 'exact', reproc: 'rerun the job' },
        scene: scene([db('log', 1, 1, 'Event log', { sub: 'all of yesterday' }), worker('b', 5, 1, 'Batch job', { sub: '02:00, 40 min' }), storage('rep', 9, 1, 'Daily report', { sub: 'exact' })], [link('log', 'b', { flow: 'to', rate: 'heavy', label: 'read all' }), link('b', 'rep', { flow: 'to', label: 'write once' })]),
      },
      {
        short: 'The door',
        chapter: 'problem',
        title: 'The venue cannot wait until 02:00',
        body: [
          'The gate screen needs "scans in the last five minutes, per entrance", updated every few seconds, to open more lanes before a queue forms. A batch job over five-minute slices could run every five seconds, but it would re-read the same events thousands of times and still be late by its own runtime.',
          'The input is not bounded; scans keep arriving. The answer is not a report but a number that keeps changing. That is a **stream**.',
        ],
        metrics: { fresh: '5–40 min', exact: 'exact', reproc: 'rerun' },
        scene: scene([users('g', 0, 1, 'Gates', { sub: 'scans, unbounded' }), queue('t', 4, 1, 'topic: scans'), worker('b', 8, 1, 'Batch every 5 s?', { sub: 'late by its runtime', state: 'warn' }), note('scr', 11, 1, 'door screen', { sub: 'needs now' })], [link('g', 't', { flow: 'to', rate: 'heavy' }), link('t', 'b', { flow: 'to', rate: 'heavy', state: 'dashed' }), link('b', 'scr', { flow: 'to', rate: 'light', state: 'fail' })]),
      },
      {
        short: 'Stream',
        chapter: 'technique',
        title: 'Process each event as it arrives',
        body: [
          'A **stream processor** (Flink, Kafka Streams, Spark Streaming) subscribes to the scans topic and keeps running state: a count per entrance for the current five-minute **window**. Each scan increments a count; every few seconds the current counts are emitted to the screen. Freshness is seconds, and the events are read once.',
          'The processor keeps its state in a local store checkpointed to durable storage, so a crash resumes from the last checkpoint without recounting from the beginning of time.',
        ],
        callout: { kind: 'insight', text: 'Batch computes a function of all the data. Stream computes a function of each event plus a little state. The second is harder to get exactly right and the only way to get an answer now.' },
        changes: ['+ Stream processor on topic scans', '+ Tumbling 5-minute windows per entrance', '~ Freshness: seconds'],
        metrics: { fresh: '3 s', exact: 'approximate', reproc: 'replay the log' },
        scene: scene([users('g', 0, 1, 'Gates'), queue('t', 3, 1, 'topic: scans'), worker('sp', 6, 1, 'Stream processor', { sub: 'window counts in state', state: 'new' }), storage('ck', 6, 3, 'checkpoints'), note('scr', 10, 1, 'door screen', { sub: 'North: 412 · South: 288' })], [link('g', 't', { flow: 'to', rate: 'heavy' }), link('t', 'sp', { flow: 'to', rate: 'heavy' }), link('sp', 'ck', { flow: 'to', rate: 'light', state: 'dashed' }), link('sp', 'scr', { flow: 'to', rate: 'light', label: 'every 3 s' })]),
      },
      {
        short: 'Late',
        chapter: 'problem',
        title: 'The scan that arrives after its window closed',
        body: [
          'A handheld scanner loses signal for two minutes and then uploads 90 scans, each stamped with the time it happened. The window they belong to has already been emitted. Count them in the current window and the screen lies about now; drop them and the totals are wrong forever.',
          'Stream processors use a **watermark**: an estimate that "no event older than T will arrive from here on". Windows stay open until the watermark passes their end, plus an allowed lateness; later events either update the earlier result (if the sink can take updates) or go to a side output. There is no setting that is right for every case; you choose how long to wait against how wrong to be.',
        ],
        callout: { kind: 'tradeoff', text: 'Event time versus processing time is the central difficulty of streams. Wait longer and results are later but more complete; emit sooner and be ready to correct them.' },
        changes: ['+ Watermark: 1 min behind newest event', '+ Allowed lateness: 5 min, results updated'],
        scene: scene([users('g', 0, 1, 'Handheld', { sub: 'offline 2 min', state: 'warn' }), queue('t', 3, 1, 'topic: scans', { sub: '90 late scans' }), worker('sp', 6, 1, 'Stream processor', { sub: 'watermark −1 min' }), note('w1', 10, 0, 'window 10:00–10:05', { sub: 'closed? reopen + correct' }), note('w2', 10, 2, 'window 10:05–10:10', { sub: 'current' })], [link('g', 't', { flow: 'to', rate: 'heavy', label: 'event time 10:03' }), link('t', 'sp', { flow: 'to' }), link('sp', 'w1', { flow: 'to', rate: 'light', state: 'dashed', label: 'late update' }), link('sp', 'w2', { flow: 'to', rate: 'light' })]),
      },
      {
        short: 'Both',
        chapter: 'recap',
        title: 'Fast and approximate now, exact later',
        body: [
          'Gigs keeps both. The stream gives the door its numbers in seconds and finance a running estimate; the nightly batch over the same event log gives the exact figures and overwrites the estimate. Running a batch and a stream side by side is the **lambda** shape. Running only the stream, and replaying the log through it when logic changes, is the **kappa** shape, which removes the duplicated logic at the cost of making the stream job carry all the correctness.',
          'Either way the event log from the pub/sub lesson is the foundation: a durable, replayable record both computations read from.',
        ],
        callout: { kind: 'recap', text: 'Batch: bounded input, exact answer, easy rerun, hours old. Stream: unbounded input, stateful windows, seconds old, must handle late events with watermarks. Keep a replayable log under both, and let batch correct stream, or replay the stream to correct itself.' },
        metrics: { fresh: '3 s / 24 h', exact: 'approx now, exact nightly', reproc: 'replay or rerun' },
        scene: scene([queue('t', 1, 1, 'event log', { sub: 'scans, orders' }), worker('sp', 5, 0, 'Stream', { sub: 'seconds, approximate' }), worker('b', 5, 2, 'Batch', { sub: 'nightly, exact' }), note('scr', 9, 0, 'door screen'), storage('rep', 9, 2, 'finance report', { sub: 'overwrites estimate' })], [link('t', 'sp', { flow: 'to', rate: 'heavy' }), link('t', 'b', { flow: 'to', rate: 'heavy', label: 'replay' }), link('sp', 'scr', { flow: 'to', rate: 'light' }), link('b', 'rep', { flow: 'to', rate: 'light' })]),
      },
    ],
    quiz: [
      q('q1', 'Which property makes a problem a stream problem rather than a batch one?', ['The data is large', 'The input is unbounded and the answer must be fresh within seconds', 'The data is in a database'], 1, 'Streams process events as they arrive to keep a continuously updated answer; batch waits for a bounded input.'),
      q('q2', 'An event arrives with a timestamp inside a window that has already been emitted. What is a watermark for?', ['Signing the event', 'Deciding how long to keep windows open for late events before emitting', 'Compressing old windows'], 1, 'A watermark estimates completeness so the processor knows when a window can close and how to treat stragglers.'),
      q('q3', 'What does the kappa architecture do instead of running a separate batch layer?', ['Drops exactness', 'Replays the event log through the same stream job when logic changes', 'Runs batch jobs more often'], 1, 'With a replayable log, one stream implementation can recompute history, removing the duplicated batch logic.'),
    ],
  }),
];

