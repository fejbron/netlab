import type { Lab } from '../types';
import { cache, cdn, db, lb, lesson, link, note, q, region, scene, server, storage, users } from '../lesson';

/* Scaling: up, then out, then stateless, then cached, then delivered from the edge. */

const MODULE = 'sd-scaling';

export const sdScalingLabs: Lab[] = [
  lesson({
    id: 'sd-04-vertical-vs-horizontal',
    moduleId: MODULE,
    order: 1,
    title: 'Vertical vs Horizontal',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Buy a bigger box, or buy more boxes: what each buys you, where each runs out, and the surprise bill at 4 a.m.',
    scenario: 'Gigs runs on one web server, and the tour announcement proved it cannot take the peak. There are two ways to add capacity. Both work; they fail differently.',
    concepts: ['Vertical scaling', 'Horizontal scaling', 'Ceilings', 'Autoscaling', 'Cost at peak'],
    metrics: [
      { key: 'users', label: 'Users online', good: 'up' },
      { key: 'servers', label: 'Servers' },
      { key: 'p95', label: 'p95', unit: 'ms', good: 'down' },
      { key: 'cost', label: 'Cost / month', unit: '$', good: 'down' },
    ],
    steps: [
      {
        short: 'One box',
        chapter: 'setup',
        title: 'One server, comfortably full',
        body: [
          'Gigs runs its web application on a single server with 4 CPUs. On a normal evening 30,000 fans are online, the server is 70% busy, and p95 latency is a healthy 90 ms. It costs $300 a month.',
          'Tickets for the big tour go on sale next week, and the forecast is 150,000 fans at once. The box will not survive that. Two options are on the table.',
        ],
        metrics: { users: 30000, servers: 1, p95: 90, cost: 300 },
        scene: scene([users('u', 1, 1, '30,000 online'), server('w', 5, 1, 'Web server', { sub: '4 CPU · 70% busy' }), db('db', 9, 1, 'Database')], [link('u', 'w', { flow: 'both' }), link('w', 'db', { flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Scale up',
        chapter: 'technique',
        title: 'Vertical: replace it with a bigger one',
        body: [
          'The quickest fix is to move to a server with 32 CPUs and eight times the memory. Nothing about the application changes: same code, same single process, same address. It takes a reboot and a bigger invoice, $2,400 a month.',
          'For a lot of systems this is the right first move. Bigger machines are simpler than more machines, and the application does not have to learn anything new.',
        ],
        callout: { kind: 'tip', text: 'Scale up first when you can. It buys time without adding moving parts. Just know that it is a loan against the ceiling, not a way through it.' },
        changes: ['~ 4 CPU → 32 CPU', '~ Cost $300 → $2,400'],
        metrics: { users: 150000, servers: 1, p95: 95, cost: 2400 },
        scene: scene([users('u', 1, 1, '150,000 online', { state: 'hot' }), server('w', 5, 1, 'Big server', { sub: '32 CPU · 65% busy', state: 'new' }), db('db', 9, 1, 'Database')], [link('u', 'w', { flow: 'both', rate: 'heavy' }), link('w', 'db', { flow: 'both' })]),
      },
      {
        short: 'Ceiling',
        chapter: 'problem',
        title: 'The biggest box is still one box',
        body: [
          'Three problems arrive together. The next size up barely exists and costs five times as much per CPU, so the price curve bends sharply upward. The whole site still depends on one machine: when it reboots, Gigs is offline. And off-peak, the 32 CPUs sit 90% idle while the bill does not.',
          'Vertical scaling has a hard ceiling (the largest machine you can buy) and a soft one (the price you can justify). Both are closer than they look.',
        ],
        callout: { kind: 'warn', text: 'One big server is still a single point of failure. The reliability module comes back to this; for now, notice that "more capacity" did nothing for "survives a reboot".' },
        changes: ['− Site down during a restart', '~ 4 a.m.: 5% busy, same $2,400'],
        metrics: { users: 4000, servers: 1, p95: 90, cost: 2400 },
        scene: scene([users('u', 1, 1, '4,000 online', { sub: '4 a.m.' }), server('w', 5, 1, 'Big server', { sub: '32 CPU · 5% busy', tag: 'IDLE, STILL PAID' }), db('db', 9, 1, 'Database')], [link('u', 'w', { flow: 'both', rate: 'light' }), link('w', 'db', { flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Scale out',
        chapter: 'technique',
        title: 'Horizontal: more of the small ones',
        body: [
          'The other option keeps the $300 servers and runs several. Five of them handle the 150,000-fan peak for $1,500 a month, and if one dies the other four carry on. Add a sixth and capacity goes up by a fifth; there is no ceiling in sight.',
          'There is a catch, and it is why this is a technique rather than a purchase: something has to split the traffic between them, and the application must not care *which* server a request lands on. Those are the next two lessons.',
        ],
        callout: { kind: 'insight', text: 'Horizontal scaling trades a hardware limit for a software requirement. The servers are cheap; the discipline of making the app indifferent to which one it runs on is the real cost.' },
        changes: ['+ 5 small servers', '+ Something to spread traffic (next lesson)', '~ Cost $1,500'],
        metrics: { users: 150000, servers: 5, p95: 92, cost: 1500 },
        scene: scene(
          [users('u', 0, 2, '150,000 online'), lb('lb', 3, 2, 'Balancer', { sub: 'next lesson', state: 'new' }), server('a', 6, 0, 'Server A'), server('b', 6, 1, 'Server B'), server('c', 6, 2, 'Server C'), server('d', 6, 3, 'Server D'), server('e', 6, 4, 'Server E'), db('db', 10, 2, 'Database')],
          [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'a', { flow: 'both' }), link('lb', 'b', { flow: 'both' }), link('lb', 'c', { flow: 'both' }), link('lb', 'd', { flow: 'both' }), link('lb', 'e', { flow: 'both' }), link('a', 'db', { flow: 'both', rate: 'light' }), link('c', 'db', { flow: 'both', rate: 'light' }), link('e', 'db', { flow: 'both', rate: 'light' })],
        ),
      },
      {
        short: 'Autoscale',
        chapter: 'solution',
        title: 'Match the fleet to the hour',
        body: [
          'Once servers are interchangeable, their number can follow the traffic. At 4 a.m. two servers are plenty; the other three are switched off and not billed. At noon the autoscaler adds them back, on a rule like "keep average CPU under 60%".',
          'The monthly bill drops to roughly $900, below the single big box, with more capacity at peak and a fleet that survives losing a member.',
        ],
        callout: { kind: 'tip', text: 'Autoscaling only works when a new server is useful the moment it starts: no local state, no manual setup, nothing it must be told. Stateless services, two lessons on, are what make that true.' },
        changes: ['− 3 servers off overnight', '~ Cost ≈ $900 / month'],
        metrics: { users: 4000, servers: 2, p95: 88, cost: 900 },
        scene: scene(
          [users('u', 0, 2, '4,000 online', { sub: '4 a.m.' }), lb('lb', 3, 2, 'Balancer'), server('a', 6, 1, 'Server A', { sub: '12% busy' }), server('b', 6, 2, 'Server B', { sub: '11% busy', tag: 'autoscaled 2 of 2–8' }), server('c', 6, 3, 'off', { state: 'dim' }), db('db', 10, 2, 'Database')],
          [link('u', 'lb', { flow: 'both', rate: 'light' }), link('lb', 'a', { flow: 'both', rate: 'light' }), link('lb', 'b', { flow: 'both', rate: 'light' }), link('lb', 'c', { state: 'off', flow: 'none' }), link('a', 'db', { flow: 'both', rate: 'light' }), link('b', 'db', { flow: 'both', rate: 'light' })],
        ),
      },
      {
        short: 'Flash sale',
        chapter: 'problem',
        title: 'Case: the sale that started on time',
        body: [
          'Tickets go on sale at 10:00 sharp, and traffic goes from 20,000 fans to 400,000 in ninety seconds. The autoscaler notices at 10:01 and asks for six more servers. Each takes about three minutes to boot, install, and warm up. Until 10:04, two servers face a load meant for eight, and a third of requests fail.',
          'Autoscaling *reacts*. It cannot predict. For an event you know about, scale ahead of time: a scheduled rule at 09:45, or simply a larger floor for the day. For spikes you cannot predict, keep headroom.',
        ],
        callout: { kind: 'recap', text: 'Scale up for simplicity until the price curve bends; scale out for capacity without a ceiling and for surviving failures. Scaling out needs a balancer and a stateless app, and autoscaling needs you to pre-warm for the peaks you can see coming.' },
        changes: ['~ 20k → 400k fans in 90 s', '+ 6 servers booting ≈ 3 min', '− Errors until they arrive'],
        metrics: { users: 400000, servers: 2, p95: 2600, cost: 900 },
        scene: scene(
          [users('u', 0, 2, '400,000 online', { sub: '10:01', state: 'hot' }), lb('lb', 3, 2, 'Balancer'), server('a', 6, 0, 'Server A', { sub: '100% busy', state: 'hot' }), server('b', 6, 1, 'Server B', { sub: '100% busy', state: 'hot' }), server('c', 6, 2, 'booting', { sub: '≈ 3 min', state: 'dim' }), server('d', 6, 3, 'booting', { sub: '≈ 3 min', state: 'dim' }), server('e', 6, 4, 'booting', { sub: '≈ 3 min', state: 'dim' }), db('db', 10, 2, 'Database')],
          [link('u', 'lb', { flow: 'to', rate: 'heavy', state: 'fail', label: '34% errors' }), link('lb', 'a', { flow: 'both', rate: 'heavy' }), link('lb', 'b', { flow: 'both', rate: 'heavy' }), link('lb', 'c', { state: 'off', flow: 'none' }), link('lb', 'd', { state: 'off', flow: 'none' }), link('lb', 'e', { state: 'off', flow: 'none' }), link('a', 'db', { flow: 'both' }), link('b', 'db', { flow: 'both' })],
        ),
      },
    ],
    quiz: [
      q('q1', 'A single large server handles today’s peak at 60% CPU. Which problem does it still have?', ['It cannot run the application without changes', 'It is a single point of failure and is paid for while idle', 'It cannot be monitored'], 1, 'Vertical scaling adds capacity but keeps one machine; a restart takes the site down and off-peak capacity is wasted.'),
      q('q2', 'What must be true of an application before adding servers behind a balancer helps?', ['It must be written in a compiled language', 'Any request must be servable by any server', 'It must use a single database connection'], 1, 'Horizontal scaling requires that servers be interchangeable, which is what the stateless-services lesson is about.'),
      q('q3', 'A known 10:00 sale will multiply traffic twentyfold in a minute. What should the autoscaler do?', ['React when CPU rises, as usual', 'Be given a scheduled rule or a higher floor before 10:00', 'Be turned off so the fleet stays stable'], 1, 'Boot time means reactive scaling arrives minutes late; a predictable spike should be pre-warmed.'),
    ],
  }),

  lesson({
    id: 'sd-05-load-balancing',
    moduleId: MODULE,
    order: 2,
    title: 'Load Balancing',
    difficulty: 'Beginner',
    estimatedMinutes: 12,
    description: 'The box in front of the fleet: how it picks a server, how it notices a dead one, and what happens when it is the thing that dies.',
    scenario: 'Gigs now has five web servers and one address. Something has to answer that address and spread the requests across the five. That something is a load balancer, and it has a few decisions to make per request.',
    concepts: ['Round robin', 'Least connections', 'Health checks', 'Layer 4 vs layer 7', 'Balancer redundancy'],
    metrics: [
      { key: 'rps', label: 'Requests/s' },
      { key: 'healthy', label: 'Healthy servers' },
      { key: 'errors', label: 'Errors/s', good: 'down' },
      { key: 'p95', label: 'p95', unit: 'ms', good: 'down' },
    ],
    steps: [
      {
        short: 'One address',
        chapter: 'setup',
        title: 'One address, five servers',
        body: [
          'DNS points `gigs.example` at a single IP address. That address belongs to the **load balancer**, a small, fast machine whose only job is to accept connections and hand each request to one of the web servers behind it. The servers themselves are not reachable from the internet at all.',
          'From the customer’s side nothing changed. From the server’s side, every request now arrives from the balancer.',
        ],
        metrics: { rps: 2000, healthy: 5, errors: 0, p95: 90 },
        scene: scene(
          [users('u', 0, 2, '2,000 req/s'), lb('lb', 3, 2, 'Balancer', { sub: '198.51.100.12' }), region('priv', 6, 0, 1, 5, 'private network'), server('a', 6, 0, 'Server A'), server('b', 6, 1, 'Server B'), server('c', 6, 2, 'Server C'), server('d', 6, 3, 'Server D'), server('e', 6, 4, 'Server E')],
          [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'a', { flow: 'both' }), link('lb', 'b', { flow: 'both' }), link('lb', 'c', { flow: 'both' }), link('lb', 'd', { flow: 'both' }), link('lb', 'e', { flow: 'both' })],
        ),
      },
      {
        short: 'Round robin',
        chapter: 'technique',
        title: 'Take turns',
        body: [
          'The simplest rule is **round robin**: first request to A, second to B, and so on around the ring. It needs no information about the servers and spreads requests evenly by count.',
          'Evenly by count is not evenly by work. If one request is a cheap health page and the next renders a 2,000-row seating chart, A and B get equal requests and unequal load. For a fleet of identical servers doing similar work, that averages out well enough, and round robin is a perfectly good default.',
        ],
        callout: { kind: 'tip', text: 'Weighted round robin lets a server twice as big take twice as many turns. It is the usual answer when the fleet is not uniform.' },
        scene: scene(
          [users('u', 0, 2, '2,000 req/s'), lb('lb', 3, 2, 'Balancer', { sub: 'round robin' }), server('a', 6, 0, 'Server A', { sub: '400 req/s' }), server('b', 6, 1, 'Server B', { sub: '400 req/s' }), server('c', 6, 2, 'Server C', { sub: '400 req/s' }), server('d', 6, 3, 'Server D', { sub: '400 req/s' }), server('e', 6, 4, 'Server E', { sub: '400 req/s' })],
          [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'a', { flow: 'to', label: '1, 6, 11…' }), link('lb', 'b', { flow: 'to', label: '2, 7, 12…' }), link('lb', 'c', { flow: 'to' }), link('lb', 'd', { flow: 'to' }), link('lb', 'e', { flow: 'to' })],
        ),
      },
      {
        short: 'Least busy',
        chapter: 'technique',
        title: 'Send it where the queue is shortest',
        body: [
          '**Least connections** looks at how many requests each server is currently handling and picks the one with the fewest. A server bogged down by slow requests naturally receives less new work. It adapts to uneven requests and to a server that is quietly struggling.',
          'The balancer must track the open connections, which it can, because every one of them passes through it. For long-lived or wildly varying requests, this beats round robin clearly.',
        ],
        changes: ['~ Round robin → least connections', '~ Server C, mid-slow-query, gets fewer new requests'],
        metrics: { p95: 82 },
        scene: scene(
          [users('u', 0, 2, '2,000 req/s'), lb('lb', 3, 2, 'Balancer', { sub: 'least connections' }), server('a', 6, 0, 'Server A', { sub: '14 open' }), server('b', 6, 1, 'Server B', { sub: '13 open' }), server('c', 6, 2, 'Server C', { sub: '41 open', state: 'warn', tag: 'slow queries' }), server('d', 6, 3, 'Server D', { sub: '15 open' }), server('e', 6, 4, 'Server E', { sub: '12 open' })],
          [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'a', { flow: 'to' }), link('lb', 'b', { flow: 'to' }), link('lb', 'c', { flow: 'to', rate: 'light' }), link('lb', 'd', { flow: 'to' }), link('lb', 'e', { flow: 'to', rate: 'heavy' })],
        ),
      },
      {
        short: 'Health checks',
        chapter: 'problem',
        title: 'Server D stops answering',
        body: [
          'At 14:02 Server D’s process crashes. The balancer does not know, and keeps sending it every fifth request. Those customers see an error page. This is the moment a balancer earns its keep, if it is configured to.',
          'A **health check** is a tiny request the balancer sends to each server every few seconds, `GET /health`. Two failures in a row and the server is marked unhealthy and removed from rotation; two successes and it is back. From 14:02:10, D gets nothing, and the other four absorb its share.',
        ],
        callout: { kind: 'warn', text: 'A health check that only tests "is the process up" misses a server whose database connection is broken. Good health endpoints check the dependencies the server actually needs to serve a request, and nothing more.' },
        changes: ['− Server D crashed at 14:02', '+ Health check every 5 s, 2 failures to eject', '~ 14:02:10: D out of rotation'],
        metrics: { healthy: 4, errors: 0, p95: 95 },
        scene: scene(
          [users('u', 0, 2, '2,000 req/s'), lb('lb', 3, 2, 'Balancer', { sub: 'GET /health · 5 s' }), server('a', 6, 0, 'Server A', { sub: '500 req/s' }), server('b', 6, 1, 'Server B', { sub: '500 req/s' }), server('c', 6, 2, 'Server C', { sub: '500 req/s' }), server('d', 6, 3, 'Server D', { state: 'down', sub: 'crashed 14:02' }), server('e', 6, 4, 'Server E', { sub: '500 req/s' })],
          [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'a', { flow: 'to' }), link('lb', 'b', { flow: 'to' }), link('lb', 'c', { flow: 'to' }), link('lb', 'd', { state: 'fail', flow: 'to', rate: 'light', label: 'health: 2 fails' }), link('lb', 'e', { flow: 'to' })],
        ),
      },
      {
        short: 'L4 vs L7',
        chapter: 'insight',
        title: 'How much does the balancer read?',
        body: [
          'A **layer 4** balancer looks only at addresses and ports. It forwards bytes without understanding them, which makes it very fast and able to carry any protocol. A **layer 7** balancer terminates the connection, reads the HTTP request, and can route on it: `/api/*` to the API fleet, `/images/*` to the image servers, a cookie to a particular version for a canary.',
          'Layer 7 costs more CPU per request and must handle TLS itself. In exchange it is where a lot of useful behaviour lives: sticky sessions, retries to another server, compression, and a single place to add a header.',
        ],
        callout: { kind: 'tradeoff', text: 'Layer 4 for raw throughput and non-HTTP protocols; layer 7 for routing by what the request is. Many systems use both: an L4 balancer in front of a pair of L7 balancers.' },
        scene: scene(
          [users('u', 0, 1, '2,000 req/s'), lb('lb', 3, 1, 'L7 balancer', { sub: 'reads the request' }), region('web', 6, 0, 1, 2, 'web fleet'), server('a', 6, 0, 'Web A'), server('b', 6, 1, 'Web B'), region('api', 9, 0, 1, 2, 'api fleet'), server('p', 9, 0, 'API A'), server('q', 9, 1, 'API B')],
          [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'a', { flow: 'to', label: '/ , /events' }), link('lb', 'b', { flow: 'to' }), link('lb', 'p', { flow: 'to', label: '/api/*' }), link('lb', 'q', { flow: 'to' })],
        ),
      },
      {
        short: 'Who balances the balancer',
        chapter: 'problem',
        title: 'The balancer is now the single point of failure',
        body: [
          'Every request passes through one machine. If it fails, five healthy servers sit behind a dead door. The usual answer is a **pair** of balancers that share a virtual IP: the active one holds the address and answers; the standby watches it with its own heartbeat and takes the address over within a few seconds if the active one goes quiet.',
          'The same idea again at the next layer up: DNS can return several balancer addresses, in several regions, and stop returning one that is failing. There is always a layer above the one you just made redundant; you stop when the cost of the next failure is one you can live with.',
        ],
        callout: { kind: 'recap', text: 'A balancer gives a fleet one address, spreads requests by round robin or least connections, ejects servers that fail health checks, and at layer 7 routes on the request itself. Being in front of everything, it needs a standby of its own.' },
        changes: ['+ Standby balancer with heartbeat', '+ Shared virtual IP fails over in ≈ 3 s'],
        metrics: { healthy: 5, errors: 0, p95: 90 },
        scene: scene(
          [users('u', 0, 2, '2,000 req/s'), lb('lb', 3, 1, 'Balancer (active)', { sub: 'holds 198.51.100.12' }), lb('lb2', 3, 3, 'Balancer (standby)', { sub: 'heartbeat', state: 'new' }), server('a', 6, 0, 'Server A'), server('b', 6, 1, 'Server B'), server('c', 6, 2, 'Server C'), server('d', 6, 3, 'Server D', { sub: 'back in rotation' }), server('e', 6, 4, 'Server E')],
          [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('u', 'lb2', { state: 'off', flow: 'none' }), link('lb', 'lb2', { state: 'dashed', flow: 'both', rate: 'light', label: 'heartbeat' }), link('lb', 'a', { flow: 'to' }), link('lb', 'b', { flow: 'to' }), link('lb', 'c', { flow: 'to' }), link('lb', 'd', { flow: 'to' }), link('lb', 'e', { flow: 'to' })],
        ),
      },
    ],
    quiz: [
      q('q1', 'Requests vary from 5 ms to 5 seconds of work. Which algorithm keeps the fleet most evenly loaded?', ['Round robin', 'Least connections', 'Random'], 1, 'Least connections sends new work to the server with the fewest in-flight requests, so slow requests naturally reduce what that server is given next.'),
      q('q2', 'A server crashes but the balancer keeps sending it traffic for a minute. What is missing?', ['A layer 7 balancer', 'Health checks that eject a failing server', 'Weighted round robin'], 1, 'Health checks are how a balancer learns a server is unhealthy; without them it keeps routing to the address.'),
      q('q3', 'You want `/api/*` to go to one fleet and everything else to another. What do you need?', ['A layer 4 balancer', 'A layer 7 balancer that reads the HTTP request', 'A second DNS record'], 1, 'Routing by path requires reading the HTTP request, which only a layer 7 balancer does.'),
    ],
  }),

  lesson({
    id: 'sd-06-stateless-services',
    moduleId: MODULE,
    order: 3,
    title: 'Stateless Services',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Why a shopping basket vanishes when the balancer picks a different server, and where the basket should have lived all along.',
    scenario: 'The fleet is balanced, and then the complaints start: fans add tickets to their basket, click Checkout, and find the basket empty. Nothing is broken on any one server. The problem is where each server keeps its memories.',
    concepts: ['Server-side state', 'Sticky sessions', 'Externalised state', 'Session stores', 'Autoscaling safely'],
    metrics: [
      { key: 'servers', label: 'Servers' },
      { key: 'lost', label: 'Baskets lost/min', good: 'down' },
      { key: 'balance', label: 'Load spread', good: 'up' },
    ],
    steps: [
      {
        short: 'Lost basket',
        chapter: 'problem',
        title: 'The basket that vanishes',
        body: [
          'A fan adds two tickets. The request lands on Server B, which stores the basket in its own memory under the fan’s session ID. The fan clicks Checkout. The balancer, doing its job, sends that request to Server D. D has never heard of this session. Empty basket.',
          'Each server is correct on its own. The bug is that the **state** (the basket) lives on one server and the **traffic** lives on all of them.',
        ],
        metrics: { servers: 5, lost: 120, balance: 'even' },
        scene: scene(
          [users('u', 0, 1, 'Fan', { sub: 'session 7f3a' }), lb('lb', 3, 1, 'Balancer'), server('b', 6, 0, 'Server B', { sub: 'basket: 2 tickets', tag: 'has the basket' }), server('d', 6, 2, 'Server D', { sub: 'basket: ?', state: 'warn' })],
          [link('u', 'lb', { flow: 'to', label: 'checkout' }), link('lb', 'b', { state: 'dashed', flow: 'none', label: 'earlier' }), link('lb', 'd', { flow: 'to', state: 'fail', label: 'now' })],
        ),
      },
      {
        short: 'Sticky',
        chapter: 'technique',
        title: 'Patch: pin each fan to a server',
        body: [
          'The quick fix is **sticky sessions**: the balancer remembers (usually with a cookie) which server a session first hit and sends it there every time. The basket is found again. It takes one setting and no application changes, which is why so many systems run this way.',
          'And it quietly undoes much of the point of the fleet. Load stops being spread per request and becomes spread per session, and long sessions pile up unevenly. Worse, if Server B dies, every basket on it is gone for good, and the fans pinned to it are now pinned to a corpse.',
        ],
        callout: { kind: 'warn', text: 'Stickiness makes servers un-interchangeable again. Autoscaling cannot drain a server that is holding state nobody else has, so scaling in means losing data.' },
        changes: ['+ Sticky sessions by cookie', '~ Baskets found again', '− Load uneven, servers not disposable'],
        metrics: { lost: 0, balance: 'uneven' },
        scene: scene(
          [users('u', 0, 1, 'Fan', { sub: 'cookie: srv=B' }), lb('lb', 3, 1, 'Balancer', { sub: 'sticky' }), server('b', 6, 0, 'Server B', { sub: '2,900 sessions', state: 'hot' }), server('d', 6, 2, 'Server D', { sub: '600 sessions' })],
          [link('u', 'lb', { flow: 'to' }), link('lb', 'b', { flow: 'to', rate: 'heavy', label: 'always B' }), link('lb', 'd', { flow: 'to', rate: 'light' })],
        ),
      },
      {
        short: 'Lose a server',
        chapter: 'problem',
        title: 'Server B goes down with 2,900 baskets',
        body: [
          'A deploy restarts Server B. Its memory, and every basket in it, is gone. The balancer dutifully moves those fans to other servers, where they arrive with a session cookie nobody can honour. 2,900 empty baskets, in the middle of a sale.',
          'Sticky sessions did not solve the problem; they moved it from "every request" to "every restart". For a fleet that is meant to scale in and out all day, every restart is often.',
        ],
        changes: ['− Server B restarted', '− 2,900 baskets lost at once'],
        metrics: { servers: 4, lost: 2900 },
        scene: scene(
          [users('u', 0, 1, '2,900 fans', { sub: 'cookie: srv=B', state: 'hot' }), lb('lb', 3, 1, 'Balancer', { sub: 'sticky' }), server('b', 6, 0, 'Server B', { state: 'down', sub: 'baskets gone' }), server('d', 6, 2, 'Server D', { sub: 'basket: ?' })],
          [link('u', 'lb', { flow: 'to', rate: 'heavy' }), link('lb', 'b', { state: 'fail', flow: 'to' }), link('lb', 'd', { flow: 'to', state: 'dashed', label: 'reassigned, empty' })],
        ),
      },
      {
        short: 'Move the state',
        chapter: 'solution',
        title: 'Keep the basket somewhere every server can reach',
        body: [
          'The real fix is to take the state out of the servers. The basket goes into a shared **session store**, a fast key-value service such as Redis, keyed by session ID. Any server handling any request reads the basket from the store, changes it, and writes it back. The servers keep nothing between requests. They are **stateless**.',
          'Now the balancer can send each request anywhere, a server can be killed at any moment, and a new one is useful the second it boots. The basket survives all of it, because it was never on a web server.',
        ],
        callout: { kind: 'insight', text: '"Stateless" does not mean the system has no state. It means the state lives in things built to hold it (databases, caches, session stores), and the servers that do the work are disposable.' },
        changes: ['+ Session store (Redis)', '− Sticky sessions', '~ Servers hold nothing between requests'],
        metrics: { servers: 5, lost: 0, balance: 'even' },
        scene: scene(
          [users('u', 0, 1, 'Fan', { sub: 'session 7f3a' }), lb('lb', 3, 1, 'Balancer', { sub: 'any server' }), server('b', 6, 0, 'Server B', { sub: 'stateless' }), server('d', 6, 2, 'Server D', { sub: 'stateless' }), cache('s', 9, 1, 'Session store', { sub: '7f3a → 2 tickets', state: 'new' }), db('db', 9, 3, 'Database')],
          [link('u', 'lb', { flow: 'to' }), link('lb', 'b', { flow: 'to' }), link('lb', 'd', { flow: 'to' }), link('b', 's', { flow: 'both', label: 'get/set 7f3a' }), link('d', 's', { flow: 'both' }), link('d', 'db', { flow: 'both', rate: 'light' })],
        ),
      },
      {
        short: 'What else hides',
        chapter: 'insight',
        title: 'State hides in more places than the basket',
        body: [
          'Baskets were the visible case. The same bug lives in uploaded files saved to a local disk, in in-memory caches that each server fills separately, in rate-limit counters kept per process, and in background jobs scheduled on "the" server. Each of these works on one machine and breaks silently on five.',
          'The test is simple: if this server were replaced by a fresh one right now, would any request get a different answer? If yes, something is stateful that should not be. Uploaded files go to object storage, shared caches to a cache service, counters to the store, and jobs to a queue.',
        ],
        callout: { kind: 'recap', text: 'Horizontal scaling needs interchangeable servers. Sticky sessions fake it and fail on restart. Moving state to a shared store makes the servers disposable, which is what balancing, autoscaling and painless deploys all depend on.' },
        scene: scene(
          [region('fleet', 0, 0, 3, 2, 'stateless servers'), server('a', 0, 0, 'Server A'), server('b', 2, 0, 'Server B'), server('c', 0, 1, 'Server C'), server('d', 2, 1, 'Server D'), cache('s', 5, 0, 'Session store', { sub: 'sessions, counters' }), storage('os', 5, 1, 'Object storage', { sub: 'uploads' }), db('db', 8, 0, 'Database', { sub: 'orders, events' }), note('qn', 8, 1, 'Queue', { sub: 'background jobs' })],
          [link('b', 's', { flow: 'both' }), link('d', 'os', { flow: 'to' }), link('b', 'db', { flow: 'both', rate: 'light' }), link('d', 'qn', { flow: 'to', rate: 'light' })],
        ),
      },
    ],
    quiz: [
      q('q1', 'A fan’s basket is on Server B and their next request lands on Server D. What is the root cause?', ['The balancer is misconfigured', 'State lives on one server while traffic goes to all of them', 'The session cookie expired'], 1, 'The servers are correct individually; the design keeps per-user state in a place only one server can see.'),
      q('q2', 'Why are sticky sessions not a real fix for server-held baskets?', ['They make requests slower', 'A restart of the pinned server still loses every basket on it, and load becomes uneven', 'They require a layer 4 balancer'], 1, 'Stickiness only hides the problem until the pinned server goes away, and it ties sessions to specific servers.'),
      q('q3', 'Which of these is a sign that a "stateless" service still holds state?', ['It reads from a shared cache', 'Uploaded files are saved to the server’s local disk', 'It writes orders to the database'], 1, 'Files on a local disk can only be served by that server; shared caches and databases are where state is supposed to live.'),
    ],
  }),

  lesson({
    id: 'sd-07-caching',
    moduleId: MODULE,
    order: 4,
    title: 'Caching',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Answer the same question once: hit rates, where the cache sits, the two hard problems of expiry and invalidation, and the stampede that follows a cold cache.',
    scenario: 'Every one of the 2,000 requests a second asks the database for the same list of upcoming events. The list changes a few times an hour. The database is doing two thousand identical queries a second to produce an answer that is nearly always the same as last time.',
    concepts: ['Cache hit rate', 'Cache-aside', 'TTL', 'Invalidation', 'Stampedes'],
    metrics: [
      { key: 'dbq', label: 'DB queries/s', good: 'down' },
      { key: 'hit', label: 'Hit rate', unit: '%', good: 'up' },
      { key: 'p95', label: 'p95', unit: 'ms', good: 'down' },
      { key: 'stale', label: 'Max staleness' },
    ],
    steps: [
      {
        short: 'Same question',
        chapter: 'problem',
        title: 'Two thousand copies of one answer',
        body: [
          'The events page runs one query: the next 50 events, with venue and price. Two thousand times a second. The query takes 40 ms and the database spends most of its CPU on it. The result changes when an event is added or sells out, a few times an hour.',
          'The database is being asked to recompute an answer it already knows. That is the shape of every caching problem: **expensive to produce, cheap to copy, slow to change**.',
        ],
        metrics: { dbq: 2000, hit: 0, p95: 90, stale: '0 s' },
        scene: scene([users('u', 0, 1, '2,000 req/s'), lb('lb', 3, 1, 'Balancer'), server('w', 6, 1, 'Web fleet'), db('db', 9, 1, 'Database', { sub: '2,000 q/s · 95% CPU', state: 'hot' })], [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'w', { flow: 'both', rate: 'heavy' }), link('w', 'db', { flow: 'both', rate: 'heavy', label: 'same SELECT' })]),
      },
      {
        short: 'Cache aside',
        chapter: 'technique',
        title: 'Look in the cache first',
        body: [
          'Put a **cache** beside the database: an in-memory key-value service holding `events:upcoming` → the rendered list. The application follows one rule, **cache-aside**: look in the cache; on a *hit*, return it; on a *miss*, query the database, store the answer in the cache, return it.',
          'The first request misses. The next few thousand hit. The database sees a handful of queries a minute instead of two thousand a second, and a hit is served from memory in under a millisecond.',
        ],
        callout: { kind: 'tip', text: 'The hit rate is the number to watch. 95% means the database sees one request in twenty. 50% means the cache is barely helping and may be costing more than it saves.' },
        changes: ['+ Cache (in memory)', '+ Key events:upcoming', '~ DB 2,000 → 4 q/s'],
        metrics: { dbq: 4, hit: 99.8, p95: 12 },
        scene: scene([users('u', 0, 1, '2,000 req/s'), lb('lb', 3, 1, 'Balancer'), server('w', 6, 1, 'Web fleet'), cache('c', 9, 0, 'Cache', { sub: 'hit 99.8%', state: 'new' }), db('db', 9, 2, 'Database', { sub: '4 q/s · 3% CPU' })], [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'w', { flow: 'both', rate: 'heavy' }), link('w', 'c', { flow: 'both', rate: 'heavy', label: 'hit' }), link('w', 'db', { flow: 'both', rate: 'light', label: 'miss' })]),
      },
      {
        short: 'Stale',
        chapter: 'problem',
        title: 'The show that sold out an hour ago',
        body: [
          'An event sells out. The database knows. The cache still holds the old list, and will forever, because nothing ever told it otherwise. Fans keep seeing tickets that do not exist.',
          'A cached answer is a copy, and copies go stale. The question every cache must answer is: **how long is a copy allowed to be wrong?** For an events list, maybe a minute. For a seat map during a sale, seconds. For an account balance, not at all.',
        ],
        callout: { kind: 'insight', text: 'There are only two hard things in caching: knowing when a copy is wrong, and deciding what to do about it. Everything else is a hash map.' },
        changes: ['− Event sold out; cache still says available'],
        metrics: { stale: 'forever' },
        scene: scene([users('u', 0, 1, 'Fans', { sub: 'see "available"' }), server('w', 4, 1, 'Web fleet'), cache('c', 7, 0, 'Cache', { sub: 'old list', state: 'warn', tag: 'STALE' }), db('db', 7, 2, 'Database', { sub: 'event 42: sold out' })], [link('u', 'w', { flow: 'both', rate: 'heavy' }), link('w', 'c', { flow: 'both', rate: 'heavy' }), link('w', 'db', { state: 'off', flow: 'none' })]),
      },
      {
        short: 'Expire',
        chapter: 'technique',
        title: 'Answer one: let copies expire',
        body: [
          'Give every entry a **time to live** (TTL). `events:upcoming` is stored for 60 seconds; after that it is gone and the next request misses, re-queries, and re-fills. A sold-out show is visible within a minute, and the database still does one query a minute instead of two thousand a second.',
          'TTL is simple and self-healing: a wrong entry fixes itself. The cost is bounded staleness, and the trade is explicit: a longer TTL means fewer queries and older answers.',
        ],
        changes: ['+ TTL 60 s on events:upcoming', '~ Staleness bounded at 60 s'],
        metrics: { dbq: 2, hit: 99.9, stale: '60 s' },
        scene: scene([users('u', 0, 1, '2,000 req/s'), server('w', 4, 1, 'Web fleet'), cache('c', 7, 0, 'Cache', { sub: 'TTL 60 s' }), db('db', 7, 2, 'Database', { sub: '≈ 1 q/min' })], [link('u', 'w', { flow: 'both', rate: 'heavy' }), link('w', 'c', { flow: 'both', rate: 'heavy' }), link('w', 'db', { flow: 'both', rate: 'light', label: 'once a minute' })]),
      },
      {
        short: 'Invalidate',
        chapter: 'technique',
        title: 'Answer two: delete the copy when the truth changes',
        body: [
          'For things that must not be wrong for a minute, go the other way: when the application changes an event, it **deletes** the cache entry in the same code path. The next read misses and rebuilds from the fresh row. Staleness drops to the milliseconds between the write and the delete.',
          'Invalidation is precise and fragile. Every place that writes the data must remember to invalidate, and it must know every key that depends on the row. Keep the TTL as a safety net underneath it, so a forgotten invalidation is wrong for a minute rather than for ever.',
        ],
        callout: { kind: 'tradeoff', text: 'TTL: simple, always eventually right, bounded staleness. Invalidation: fresh immediately, but every writer must cooperate. Most systems use both: invalidate on write, expire as a backstop.' },
        changes: ['+ On write: DELETE events:upcoming', '~ TTL kept as a backstop'],
        metrics: { stale: '< 1 s' },
        scene: scene([server('adm', 0, 0, 'Admin app', { sub: 'marks sold out' }), server('w', 4, 1, 'Web fleet'), cache('c', 7, 0, 'Cache', { sub: 'key deleted', state: 'new' }), db('db', 7, 2, 'Database', { sub: 'event 42: sold out' })], [link('adm', 'db', { flow: 'to', label: 'UPDATE' }), link('adm', 'c', { flow: 'to', label: 'DELETE key', state: 'dashed' }), link('w', 'c', { flow: 'both' }), link('w', 'db', { flow: 'both', rate: 'light', label: 'rebuild' })]),
      },
      {
        short: 'Stampede',
        chapter: 'problem',
        title: 'The cache restarts, and everyone misses at once',
        body: [
          'The cache service is restarted during a sale. Its memory is empty. In the next 100 ms, 200 requests all miss, all run the 40 ms query, and all try to fill the same key. The database, idle a second ago, is hit with a burst it has not seen since before the cache existed. This is a **stampede** (or thundering herd), and a popular key expiring causes a smaller one every TTL.',
          'The fixes are about letting one request do the work: a short **lock** on the key so one request rebuilds while the others wait or serve the old value; **serving stale** for a few seconds while a refresh runs in the background; and **jittering** TTLs so a thousand keys do not expire in the same second.',
        ],
        callout: { kind: 'recap', text: 'A cache turns repeated expensive reads into cheap ones, measured by hit rate. Copies go stale: expire them with a TTL, delete them on write, or both. And remember that a miss is a query, so a cache that empties all at once is a burst at the database.' },
        changes: ['− Cache restarted during the sale', '− 200 simultaneous misses → DB burst', '+ Fix: lock per key, serve stale, jitter TTLs'],
        metrics: { dbq: 1900, hit: 5, p95: 400 },
        scene: scene([users('u', 0, 1, '2,000 req/s', { state: 'hot' }), server('w', 4, 1, 'Web fleet'), cache('c', 7, 0, 'Cache', { sub: 'empty after restart', state: 'warn', tag: 'COLD' }), db('db', 7, 2, 'Database', { sub: '1,900 q/s', state: 'hot', tag: 'STAMPEDE' })], [link('u', 'w', { flow: 'both', rate: 'heavy' }), link('w', 'c', { flow: 'both', rate: 'light', label: 'miss, miss, miss' }), link('w', 'db', { flow: 'both', rate: 'heavy' })]),
      },
    ],
    quiz: [
      q('q1', 'A cache in front of a database shows a 40% hit rate. What is the most likely verdict?', ['It is working well; 40% is typical', 'It is barely helping, and may be adding latency on every miss', 'The TTL is too short to measure'], 1, 'At 40% the database still serves most requests, and each miss pays for a cache lookup first.'),
      q('q2', 'Which of these gives the freshest cached answer, at the cost of every writer having to cooperate?', ['A long TTL', 'Deleting the key when the underlying data changes', 'A larger cache'], 1, 'Invalidation on write removes the copy immediately; a TTL only bounds how long it can be wrong.'),
      q('q3', 'A popular key expires and 500 requests miss in the same instant. What happens without protection?', ['They all wait for one rebuild automatically', 'All 500 run the expensive query against the database at once', 'The cache refuses the key'], 1, 'Each miss triggers its own rebuild; a per-key lock, serving stale, or jittered TTLs prevent the stampede.'),
    ],
  }),

  lesson({
    id: 'sd-08-content-delivery',
    moduleId: MODULE,
    order: 5,
    title: 'Content Delivery',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Put the bytes that never change next to the people who want them: edge caches, cache keys, and the two headers that decide how long a file lives out there.',
    scenario: 'Fans in Sydney load Gigs from a server in Frankfurt. Every image, script and stylesheet crosses the planet, 300 ms each way, for files that have not changed in months.',
    concepts: ['Edge locations', 'Origin', 'Cache-Control', 'Content hashing', 'Purging'],
    metrics: [
      { key: 'syd', label: 'Sydney load', unit: 'ms', good: 'down' },
      { key: 'fra', label: 'Frankfurt load', unit: 'ms', good: 'down' },
      { key: 'origin', label: 'Origin bytes/s', good: 'down' },
    ],
    steps: [
      {
        short: 'Far origin',
        chapter: 'problem',
        title: 'Every image crosses an ocean',
        body: [
          'The events page needs the HTML plus 30 static files: the stylesheet, two scripts, and a thumbnail per event. For a fan in Frankfurt, near the server, the page is ready in 400 ms. For a fan in Sydney each file is 300 ms away, and even with several in flight at once the page takes 2.8 seconds.',
          'The server is not slow; it is far. And the files it is sending are identical for every fan on earth.',
        ],
        metrics: { syd: 2800, fra: 400, origin: '120 MB' },
        scene: scene([users('syd', 0, 2, 'Sydney', { sub: '300 ms away', state: 'hot' }), users('fra', 0, 0, 'Frankfurt', { sub: '10 ms away' }), server('o', 5, 1, 'Origin', { sub: 'Frankfurt' }), storage('s', 9, 1, 'Static files', { sub: '30 per page' })], [link('syd', 'o', { flow: 'both', rate: 'heavy', label: '30 files × 300 ms' }), link('fra', 'o', { flow: 'both' }), link('o', 's', { flow: 'from', rate: 'heavy' })]),
      },
      {
        short: 'Edge',
        chapter: 'technique',
        title: 'A cache in every city',
        body: [
          'A **content delivery network** is a cache with hundreds of locations. DNS sends each fan to the nearest **edge**. The edge checks whether it has the file; if not, it fetches it once from the **origin** (our server) and keeps a copy. The next Sydney fan gets it from Sydney, 5 ms away.',
          'The first request from each city is still slow. Every request after that is local. For files shared by everyone, the hit rate is close to 100%.',
        ],
        callout: { kind: 'insight', text: 'A CDN is the caching lesson applied to geography: the expensive thing being copied is distance, not computation.' },
        changes: ['+ CDN in front of static files', '~ Sydney edge: miss once, then hit'],
        metrics: { syd: 650, fra: 300, origin: '2 MB' },
        scene: scene([users('syd', 0, 2, 'Sydney'), users('fra', 0, 0, 'Frankfurt'), cdn('e1', 3, 2, 'Edge Sydney', { sub: 'hit 98%', state: 'new' }), cdn('e2', 3, 0, 'Edge Frankfurt', { sub: 'hit 98%', state: 'new' }), server('o', 7, 1, 'Origin', { sub: 'mostly HTML now' })], [link('syd', 'e1', { flow: 'both', rate: 'heavy', label: '5 ms' }), link('fra', 'e2', { flow: 'both', rate: 'heavy' }), link('e1', 'o', { flow: 'both', rate: 'light', label: 'miss' }), link('e2', 'o', { flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Headers',
        chapter: 'technique',
        title: 'Tell the edge how long to keep things',
        body: [
          'The origin decides the rules with one response header. `Cache-Control: public, max-age=31536000` means anyone may cache this for a year. `max-age=60` means a minute. `no-store` means never. The fan’s browser obeys the same header, so a cached stylesheet is not even requested on the second page.',
          'The HTML itself usually gets a short lifetime or none, because it is personalised or changes often. Images, scripts and styles get long ones. The difference in traffic to the origin is enormous.',
        ],
        changes: ['+ static: max-age=31536000', '+ HTML: max-age=0'],
        metrics: { syd: 500 },
        scene: scene([users('syd', 0, 1, 'Sydney', { sub: 'browser cache too' }), cdn('e1', 3, 1, 'Edge', { sub: 'honours max-age' }), server('o', 7, 0, 'Origin', { sub: 'HTML: max-age=0' }), storage('s', 7, 2, 'Static', { sub: 'max-age=1 year' })], [link('syd', 'e1', { flow: 'both', rate: 'heavy' }), link('e1', 'o', { flow: 'both', label: 'HTML each time' }), link('e1', 's', { flow: 'from', rate: 'light', label: 'once a year' })]),
      },
      {
        short: 'Deploy',
        chapter: 'problem',
        title: 'The stylesheet that would not update',
        body: [
          'A designer ships a new stylesheet. The origin has it. Every edge, and every browser, is holding the old `app.css` with 364 days left on its lease. Fans see the old design for a year, or until someone finds the **purge** button, which clears the CDN but not the browsers.',
          'Long lifetimes and changing files cannot both be true of the same URL. The fix is to stop reusing the URL.',
        ],
        callout: { kind: 'warn', text: 'A purge empties the CDN’s copies, not the copies in a million browsers. Never rely on purging for a file you told browsers to keep for a year.' },
        changes: ['− New app.css deployed; edges and browsers keep the old one'],
        scene: scene([users('syd', 0, 1, 'Sydney', { sub: 'old app.css cached', state: 'warn' }), cdn('e1', 3, 1, 'Edge', { sub: 'old app.css · 364 d left', state: 'warn', tag: 'STALE' }), server('o', 7, 1, 'Origin', { sub: 'new app.css' })], [link('syd', 'e1', { flow: 'both' }), link('e1', 'o', { state: 'off', flow: 'none', label: 'not asked' })]),
      },
      {
        short: 'Hash the name',
        chapter: 'solution',
        title: 'Change the name when the content changes',
        body: [
          'Build tools put a fingerprint of the file’s content into its name: `app.3f9c2a.css`. The new stylesheet is `app.b71e04.css`, a URL nobody has ever cached, so it is fetched fresh everywhere. The old one can stay cached for a year; no page references it any more.',
          'This is why the HTML has a short lifetime and the assets a long one: the HTML is the small, fresh thing that names the big, immutable things. Deploy the assets first and the HTML last, so no page ever names a file the edge cannot find.',
        ],
        callout: { kind: 'recap', text: 'A CDN serves static files from a cache near the user, fetching each once from the origin. Cache-Control sets the lifetime: long for assets with content-hashed names, short for the HTML that references them. Purge is for emergencies, not for deploys.' },
        changes: ['+ app.b71e04.css, cached a year', '~ HTML references the new name', '− Purging no longer needed'],
        metrics: { syd: 500, fra: 300, origin: '2 MB' },
        scene: scene([users('syd', 0, 1, 'Sydney', { sub: 'fetches new name' }), cdn('e1', 3, 1, 'Edge', { sub: 'app.b71e04.css: miss → hit' }), server('o', 7, 0, 'Origin', { sub: 'HTML names b71e04' }), storage('s', 7, 2, 'Static', { sub: 'both files kept' })], [link('syd', 'e1', { flow: 'both', rate: 'heavy' }), link('e1', 'o', { flow: 'both', label: 'HTML' }), link('e1', 's', { flow: 'from', label: 'new file once' })]),
      },
    ],
    quiz: [
      q('q1', 'What does a CDN edge do on the very first request for a file from a city?', ['Serves it from the nearest other edge', 'Fetches it from the origin and keeps a copy', 'Returns a redirect to the origin'], 1, 'The first request is a miss served via the origin; the edge keeps the copy for subsequent requests.'),
      q('q2', 'A file is served with `Cache-Control: max-age=31536000` and its content changes. What is the safe way to get users the new version?', ['Purge the CDN', 'Give the new content a new URL (content-hashed name) and update the HTML', 'Lower max-age on the origin'], 1, 'Browsers hold the old file for a year regardless of purges; a new name is a URL nobody has cached.'),
      q('q3', 'Why does the HTML page usually get a short cache lifetime while its images get a long one?', ['HTML is larger', 'HTML changes often and names the versioned assets; the assets themselves never change under one name', 'Edges cannot cache HTML'], 1, 'The HTML is the small, fresh document that references immutable, long-lived assets.'),
    ],
  }),
];

