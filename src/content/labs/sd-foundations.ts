import type { Lab } from '../types';
import { cache, client, db, dns, lb, lesson, link, note, q, scene, server, users } from '../lesson';

/*
 * Foundations: a request's journey, latency versus throughput, and napkin maths.
 * The running example throughout the path is Gigs, a small concert-ticket shop.
 */

const MODULE = 'sd-foundations';

export const sdFoundationsLabs: Lab[] = [
  lesson({
    id: 'sd-01-how-a-request-travels',
    moduleId: MODULE,
    order: 1,
    title: 'How a Request Travels',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Follow one page load from the address bar to the database and back, and see which of the 200 milliseconds you can actually do something about.',
    scenario: 'Gigs sells concert tickets from one web server and one database. Customers say the site feels sluggish. Before changing anything, trace where a single page load spends its time.',
    concepts: ['DNS', 'TCP and TLS handshakes', 'Round-trip time', 'Server time', 'Download time'],
    metrics: [
      { key: 'dns', label: 'DNS', unit: 'ms', good: 'down' },
      { key: 'connect', label: 'Connect', unit: 'ms', good: 'down' },
      { key: 'server', label: 'Server', unit: 'ms', good: 'down' },
      { key: 'download', label: 'Download', unit: 'ms', good: 'down' },
      { key: 'total', label: 'Total', unit: 'ms', good: 'down' },
    ],
    steps: [
      {
        short: 'Press Enter',
        chapter: 'problem',
        title: 'Two hundred milliseconds, unexplained',
        body: [
          'A customer types `gigs.example` and presses Enter. About a fifth of a second later the events page appears. That feels slow to them, and "slow" is not something you can fix. You need to know **where the time goes**.',
          'So we follow one request from the keyboard to the database and back, writing down the cost of every hop. The dashboard above starts empty and fills in as we go.',
        ],
        callout: { kind: 'insight', text: 'Every page load is a chain of small waits. Nobody notices any one of them; everyone notices the sum.' },
        metrics: { dns: null, connect: null, server: null, download: null, total: null },
        scene: scene([client('c', 1, 1, 'Customer', { sub: 'browser' })]),
      },
      {
        short: 'Look up',
        chapter: 'technique',
        title: 'Turn the name into an address',
        body: [
          'The network delivers packets to **IP addresses**, not names. Before anything else the browser asks a *DNS resolver*: what is the address of `gigs.example`? The answer, `198.51.100.12`, comes back in about 25 ms.',
          'The browser remembers it for the record’s *time to live*, a few minutes here, so the next page load on this site skips the lookup entirely.',
        ],
        callout: { kind: 'tip', text: 'DNS is cached at every layer: the browser, the operating system, the home router, the ISP. A cold lookup is the exception, not the rule.' },
        changes: ['+ DNS resolver', '+ Lookup: 25 ms'],
        metrics: { dns: 25, total: 25 },
        scene: scene([client('c', 1, 1, 'Customer', { sub: 'browser' }), dns('d', 4, 0, 'Resolver', { sub: '→ 198.51.100.12', state: 'new' })], [link('c', 'd', { label: 'gigs.example?', flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Connect',
        chapter: 'technique',
        title: 'Shake hands, twice',
        body: [
          'Now the browser opens a connection to `198.51.100.12`. First **TCP** agrees to talk, which takes one trip there and back. Then **TLS** sets up encryption, which takes another. Our customer is 35 ms from the server, so each *round trip* costs 35 ms and the two handshakes cost 70 ms before a single byte of the page has been requested.',
          'Notice what sets this cost: distance and the network path. Nothing you do inside the server changes it.',
        ],
        callout: { kind: 'insight', text: 'Round-trip time is paid per trip, so the way to spend less on it is to make fewer trips, or to put the server closer. Both come up again later in the path.' },
        changes: ['+ Web server', '~ DNS answer cached for next time', '+ TCP + TLS: 2 round trips = 70 ms'],
        metrics: { connect: 70, total: 95 },
        scene: scene([client('c', 1, 1, 'Customer', { sub: 'browser' }), dns('d', 4, 0, 'Resolver', { state: 'dim' }), server('w', 5, 2, 'Web server', { sub: '198.51.100.12', state: 'new' })], [link('c', 'd', { state: 'off', flow: 'none' }), link('c', 'w', { label: 'TCP · TLS', flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Request',
        chapter: 'technique',
        title: 'Ask for the page',
        body: [
          'Over the open connection the browser sends `GET /events`. The request itself is tiny, but it still has to travel to the server and the answer has to travel back: one more round trip, 35 ms.',
          'On the server, the application checks the session cookie, decides which events to show, and asks the database for them. The database query takes 40 ms, rendering the page takes 10. Server time: **50 ms**.',
        ],
        callout: { kind: 'tip', text: 'Server time is the part engineers tend to optimise first because it is the part they can see in their own logs. It is rarely the biggest slice.' },
        changes: ['+ Database', '+ Request: 1 round trip = 35 ms', '+ Query 40 ms + render 10 ms'],
        metrics: { server: 85, total: 180 },
        scene: scene(
          [client('c', 1, 1, 'Customer', { sub: 'browser' }), server('w', 5, 1, 'Web server', { sub: 'render 10 ms', state: 'hot' }), db('db', 9, 1, 'Database', { sub: 'query 40 ms', state: 'new' })],
          [link('c', 'w', { label: 'GET /events', flow: 'to' }), link('w', 'db', { label: 'SELECT …', flow: 'both' })],
        ),
      },
      {
        short: 'Download',
        chapter: 'technique',
        title: 'Bring the bytes home',
        body: [
          'The page is 60 KB of HTML. On this connection that streams down in about 20 ms, and then the browser starts rendering. Our total: 25 + 70 + 85 + 20 = **200 ms**, and that is before the stylesheet, the scripts and the images, each of which repeats part of this story.',
          'Look at the split. Only 50 ms of the 200 was the server doing work. Three quarters of the wait was the network, and most of that was round trips.',
        ],
        callout: { kind: 'insight', text: 'Latency is mostly *waiting*, not *computing*. The fastest server in the world cannot make a round trip shorter.' },
        changes: ['+ Download: 60 KB ≈ 20 ms', '~ Total 200 ms'],
        metrics: { download: 20, total: 200 },
        scene: scene(
          [client('c', 1, 1, 'Customer', { sub: 'rendering' }), server('w', 5, 1, 'Web server'), db('db', 9, 1, 'Database')],
          [link('c', 'w', { label: '60 KB', flow: 'from', rate: 'heavy' }), link('w', 'db', { state: 'dashed', flow: 'none' })],
        ),
      },
      {
        short: 'Slow query',
        chapter: 'problem',
        title: 'Case: the query that got slow',
        body: [
          'A month later the events table has grown and the same query takes 400 ms instead of 40. The total is now **560 ms**, and the server is suddenly the biggest slice. This is the failure engineers are best equipped to see and fix: an index, a better query, a cache in front of the database.',
          'The rest of the lesson’s costs did not move at all. That is the point of writing them down separately.',
        ],
        callout: { kind: 'warn', text: 'A slow database is felt by every request that touches it, so it shows up as the whole site being slow rather than one page. Measure per hop, not per page.' },
        changes: ['~ Query 40 ms → 400 ms', '~ Total 200 ms → 560 ms'],
        metrics: { server: 445, total: 560 },
        scene: scene(
          [client('c', 1, 1, 'Customer', { sub: 'waiting…' }), server('w', 5, 1, 'Web server', { sub: 'blocked on query' }), db('db', 9, 1, 'Database', { sub: 'query 400 ms', state: 'hot', tag: 'SLOW' })],
          [link('c', 'w', { flow: 'to', rate: 'light' }), link('w', 'db', { label: 'full scan', flow: 'both', rate: 'light' })],
        ),
      },
      {
        short: 'Far away',
        chapter: 'problem',
        title: 'Case: the customer on the other side of the world',
        body: [
          'Fix the query and look at a different customer, one 160 ms away instead of 35. Every round trip now costs 160 ms: 320 ms to connect, 160 to ask, and the total is **575 ms** with a server that is doing exactly the same 50 ms of work.',
          'No change to the server helps this customer much. What helps is fewer round trips (keep connections open, bundle assets) and shorter ones (a server, or at least a cache, nearer to them). That is the job of the CDN lesson later in this path.',
        ],
        callout: { kind: 'recap', text: 'A request pays for DNS, two handshakes, the request round trip, server work and the download. The network costs scale with distance; the server costs scale with your code and your data. Measure them apart and fix the one that is actually big.' },
        changes: ['~ Query back to 40 ms', '~ Round trip 35 ms → 160 ms', '~ Total 575 ms'],
        metrics: { dns: 25, connect: 320, server: 210, download: 20, total: 575 },
        scene: scene(
          [client('c', 0, 1, 'Customer', { sub: '160 ms away', state: 'hot' }), note('n', 3, 0, 'each round trip', { sub: '160 ms' }), server('w', 6, 1, 'Web server', { sub: '50 ms of work' }), db('db', 10, 1, 'Database', { sub: 'query 40 ms' }), cache('cdn', 2, 2, 'Nearby cache?', { sub: 'later in the path', state: 'dim' })],
          [link('c', 'w', { label: '3 round trips', flow: 'both', rate: 'light' }), link('w', 'db', { flow: 'both', rate: 'light' }), link('c', 'cdn', { state: 'off', flow: 'none' })],
        ),
      },
    ],
    quiz: [
      q('q1', 'A customer 100 ms away loads a page that needs a DNS lookup, a TCP and TLS handshake, one request, 50 ms of server work and a quick download. Roughly how long until the page arrives?', ['About 150 ms: mostly the server work plus one trip', 'About 450 ms: four round trips plus the server work', 'About 250 ms: two round trips plus the server work'], 1, 'DNS, TCP, TLS and the request itself each cost a round trip (4 × 100 ms) before the 50 ms of server time.'),
      q('q2', 'Which of these costs is **not** reduced by making the server faster?', ['Rendering the page', 'The database query', 'The TLS handshake'], 2, 'Handshakes are round trips, set by the distance between client and server. The server’s speed does not change them.'),
      q('q3', 'The events query grows from 40 ms to 400 ms. Which customers notice?', ['Only customers far from the server', 'Everyone whose request runs that query', 'Only customers with a cold DNS cache'], 1, 'Server time is paid by every request that does the work, regardless of where the customer is.'),
    ],
  }),

  lesson({
    id: 'sd-02-latency-and-throughput',
    moduleId: MODULE,
    order: 2,
    title: 'Latency and Throughput',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Two numbers people mix up, the percentile that matters, and why a server at 80% busy already feels slow.',
    scenario: 'Gigs is about to announce a big tour. The team wants one number to describe "how fast the site is" and one to describe "how much it can take". They are different numbers, and they interact in a way that surprises people.',
    concepts: ['Latency', 'Throughput', 'Percentiles', 'Utilisation', 'Queueing'],
    metrics: [
      { key: 'rps', label: 'Requests/s', good: 'up' },
      { key: 'util', label: 'Utilisation', unit: '%', good: 'down' },
      { key: 'p50', label: 'p50', unit: 'ms', good: 'down' },
      { key: 'p99', label: 'p99', unit: 'ms', good: 'down' },
    ],
    steps: [
      {
        short: 'Two numbers',
        chapter: 'setup',
        title: 'How fast, and how much',
        body: [
          '**Latency** is how long one request takes: the customer’s wait. **Throughput** is how many requests the system completes per second: the system’s capacity. A motorway has both: the time to drive a stretch, and the number of cars per hour it carries.',
          'They are measured in different units and you cannot trade one for the other directly. A wider road carries more cars; it does not make any single car faster.',
        ],
        metrics: { rps: 200, util: 20, p50: 60, p99: 90 },
        scene: scene([users('u', 1, 1, '200 req/s', { sub: 'quiet afternoon' }), server('w', 5, 1, 'Web server', { sub: '20% busy' }), db('db', 9, 1, 'Database')], [link('u', 'w', { flow: 'both' }), link('w', 'db', { flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Averages lie',
        chapter: 'insight',
        title: 'The average hides the people who left',
        body: [
          'Our average response is 60 ms. Sounds fine. But averages are pulled towards the common case, and the common case is not what people complain about.',
          'Sort the last 10,000 requests by time. The one in the middle is the **p50** (the median): half of requests were faster. The one 99% of the way along is the **p99**: one request in a hundred was slower than this. Here p50 is 60 ms and p99 is 90 ms. Both fine. Keep watching them.',
        ],
        callout: { kind: 'tip', text: 'Report percentiles, not averages. A page that makes 30 requests to your API hits the p99 of at least one of them about a quarter of the time, so "one in a hundred" is far more customers than it sounds.' },
        scene: scene([note('a', 1, 0, 'p50 = 60 ms', { sub: 'half are faster' }), note('b', 4, 0, 'p99 = 90 ms', { sub: '1 in 100 slower' }), users('u', 1, 2, '200 req/s'), server('w', 5, 2, 'Web server', { sub: '20% busy' }), db('db', 9, 2, 'Database')], [link('u', 'w', { flow: 'both' }), link('w', 'db', { flow: 'both', rate: 'light' })]),
      },
      {
        short: 'Tour goes on sale',
        chapter: 'problem',
        title: 'Traffic climbs, latency barely moves',
        body: [
          'The tour is announced and traffic triples to 600 req/s. The server is now 60% busy. p50 ticks up to 70 ms, p99 to 130. Everything is still comfortable, and a manager concludes the server has room for triple again.',
          'It does not, and the reason is queueing. A server is not a tap that opens wider; it is a counter with a line in front of it.',
        ],
        changes: ['~ 200 → 600 req/s', '~ Utilisation 20% → 60%'],
        metrics: { rps: 600, util: 60, p50: 70, p99: 130 },
        scene: scene([users('u', 1, 1, '600 req/s', { sub: 'tour announced' }), server('w', 5, 1, 'Web server', { sub: '60% busy', state: 'warn' }), db('db', 9, 1, 'Database')], [link('u', 'w', { flow: 'both', rate: 'heavy' }), link('w', 'db', { flow: 'both' })]),
      },
      {
        short: 'The knee',
        chapter: 'insight',
        title: 'The last 20% of capacity costs the most',
        body: [
          'Requests do not arrive evenly; they bunch. When the server is 20% busy a bunch almost never finds it occupied. At 80% busy, most arrivals find it mid-request and have to wait, and the wait includes everyone already waiting.',
          'Queueing theory makes this precise: as utilisation approaches 100%, waiting time grows roughly like 1 ÷ (1 − utilisation). From 60% to 80% busy doubles the wait; from 80% to 90% doubles it again. The curve has a **knee**, and you want to run on the flat side of it.',
        ],
        callout: { kind: 'insight', text: 'A system at 90% utilisation is not "10% from full". It is already slow, and the next small increase will make it very slow. Capacity planning aims for headroom, typically 60–70% at peak.' },
        changes: ['~ 600 → 800 req/s', '~ Utilisation 80%', '~ p99 130 → 300 ms'],
        metrics: { rps: 800, util: 80, p50: 95, p99: 300 },
        scene: scene(
          [users('u', 1, 1, '800 req/s', { sub: 'tickets on sale' }), note('qn', 3, 0, 'queue forming', { sub: 'most arrivals wait' }), server('w', 5, 1, 'Web server', { sub: '80% busy', state: 'hot' }), db('db', 9, 1, 'Database')],
          [link('u', 'w', { flow: 'both', rate: 'heavy', label: 'waiting…' }), link('w', 'db', { flow: 'both' })],
        ),
      },
      {
        short: 'Saturation',
        chapter: 'problem',
        title: 'Past the knee, throughput falls too',
        body: [
          'At 1,000 req/s the server is saturated. The queue grows without bound, p99 passes two seconds, and browsers start timing out and **retrying**, which adds load to a server that was already full. Throughput, the number of requests that actually complete, drops *below* what the server managed at 800.',
          'This is the shape of most outages: not a crash, but a slow collapse under load the system could nearly handle.',
        ],
        callout: { kind: 'warn', text: 'Overload feeds itself. Retries, impatient users refreshing, and health checks that time out all add work exactly when there is no capacity to do it. The reliability module covers how to shed load instead.' },
        changes: ['~ 1,000 req/s offered', '~ 740 req/s completed', '~ p99 2,400 ms'],
        metrics: { rps: 740, util: 100, p50: 900, p99: 2400 },
        scene: scene(
          [users('u', 1, 1, '1,000 req/s', { sub: 'refreshing', state: 'hot' }), server('w', 5, 1, 'Web server', { sub: 'saturated', state: 'down', tag: 'OVERLOADED' }), db('db', 9, 1, 'Database', { sub: 'mostly idle' })],
          [link('u', 'w', { state: 'fail', flow: 'to', rate: 'heavy', label: 'timeouts' }), link('w', 'db', { flow: 'both', rate: 'light' })],
        ),
      },
      {
        short: 'Headroom',
        chapter: 'solution',
        title: 'Add capacity before the knee, not after',
        body: [
          'The fix is not clever: a second server, so that 1,000 req/s is 50% utilisation per server rather than 100%. p99 settles back near 120 ms and throughput matches demand again. How requests get split between two servers is the next module.',
          'The lesson is what to watch. Utilisation tells you how close to the knee you are; p99 tells you when you have crossed it; throughput tells you when you have collapsed. You want all three on a dashboard, and you want to act on the first.',
        ],
        callout: { kind: 'recap', text: 'Latency is per request, throughput is per second, and they are linked by utilisation: past about 70–80% busy, a little more traffic buys a lot more waiting. Plan for headroom and read percentiles, not averages.' },
        changes: ['+ Second web server', '~ Utilisation 50% each', '~ p99 2,400 → 120 ms'],
        metrics: { rps: 1000, util: 50, p50: 65, p99: 120 },
        scene: scene(
          [users('u', 1, 1, '1,000 req/s'), lb('lb', 4, 1, 'Balancer', { sub: 'next module', state: 'new' }), server('w1', 7, 0, 'Web server A', { sub: '50% busy' }), server('w2', 7, 2, 'Web server B', { sub: '50% busy', state: 'new' }), db('db', 10, 1, 'Database')],
          [link('u', 'lb', { flow: 'both', rate: 'heavy' }), link('lb', 'w1', { flow: 'both' }), link('lb', 'w2', { flow: 'both' }), link('w1', 'db', { flow: 'both', rate: 'light' }), link('w2', 'db', { flow: 'both', rate: 'light' })],
        ),
      },
    ],
    quiz: [
      q('q1', 'A service reports an average response of 80 ms. A customer says it "takes forever" several times a day. Which number would show their experience?', ['The average over a longer window', 'The p99 (or p99.9) latency', 'The throughput in requests per second'], 1, 'Tail percentiles show the slow minority of requests; the average is dominated by the fast majority.'),
      q('q2', 'A server is at 85% utilisation and traffic is still rising slowly. What happens to p99 latency next?', ['It stays about the same until 100%', 'It rises sharply, far more than the traffic does', 'It falls, because the server is warmed up'], 1, 'Waiting time grows roughly like 1 ÷ (1 − utilisation), so the last stretch before saturation adds most of the latency.'),
      q('q3', 'Why can completed throughput **fall** when offered load goes past capacity?', ['The database refuses connections', 'Timeouts and retries add work the server cannot absorb', 'Percentiles are recalculated'], 1, 'Overload creates retries and refreshes, so the server spends its capacity on duplicate work and completes fewer unique requests.'),
    ],
  }),

  lesson({
    id: 'sd-03-napkin-math',
    moduleId: MODULE,
    order: 3,
    title: 'Napkin Math',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    description: 'Estimate traffic, storage and bandwidth from a few assumptions before anyone draws a box, and learn the handful of numbers worth memorising.',
    scenario: 'Gigs wants to add a photo wall: fans upload a picture from every show. Before designing it, work out how big it is. Ten minutes with rough numbers will tell you whether this needs one server or a fleet.',
    concepts: ['Back-of-the-envelope estimation', 'Daily active users', 'Peak factor', 'Storage growth', 'Powers of ten'],
    metrics: [
      { key: 'dau', label: 'Daily users', good: 'up' },
      { key: 'rps', label: 'Avg uploads/s' },
      { key: 'peak', label: 'Peak uploads/s' },
      { key: 'storage', label: 'Storage / year' },
    ],
    steps: [
      {
        short: 'Assumptions',
        chapter: 'setup',
        title: 'Start from what you are told',
        body: [
          'Gigs has **2 million** registered fans, and about **10%** of them open the app on a given day: 200,000 daily active users. The product team guesses one in ten of those will upload a photo on a show night, and a photo is about **2 MB** from a phone.',
          'None of these numbers is exact. Napkin maths does not need exact; it needs the right power of ten. Write the assumptions down so they can be argued with.',
        ],
        callout: { kind: 'tip', text: 'Say the assumptions out loud before computing anything. In an interview, the assumptions are the answer; the arithmetic is just checking it.' },
        metrics: { dau: 200000, rps: null, peak: null, storage: null },
        scene: scene([note('a', 1, 0, '2M registered', { sub: '10% daily → 200k' }), note('b', 4, 0, '1 in 10 uploads', { sub: '20k photos/day' }), note('c', 7, 0, '2 MB each', { sub: 'phone camera' }), users('u', 2, 2, '200k fans / day'), server('w', 6, 2, 'Photo service', { sub: 'to be designed', state: 'dim' })], [link('u', 'w', { state: 'dashed', flow: 'none' })]),
      },
      {
        short: 'Per second',
        chapter: 'technique',
        title: 'Turn a day into a second',
        body: [
          '20,000 uploads a day. A day has 86,400 seconds, which you round to **100,000** when a pen is involved. So the average is 20,000 ÷ 100,000 = **0.2 uploads per second**. Tiny.',
          'But nobody uploads at 4 a.m., and everybody uploads during the encore. Traffic concentrates. A common rule is that peak is **3× to 10×** the average, and show nights are spiky, so take 10×: about **2 uploads per second** at peak, each 2 MB.',
        ],
        callout: { kind: 'insight', text: 'Average traffic sizes your storage and your bill. Peak traffic sizes your servers. Always compute both.' },
        changes: ['+ 20k/day ÷ 100k s ≈ 0.2/s', '+ Peak ×10 ≈ 2/s'],
        metrics: { rps: 0.2, peak: 2 },
        scene: scene([users('u', 1, 1, '0.2 uploads/s', { sub: 'average' }), users('u2', 1, 3, '2 uploads/s', { sub: 'encore peak', state: 'hot' }), server('w', 6, 2, 'Photo service', { sub: '4 MB/s at peak' })], [link('u', 'w', { flow: 'to', rate: 'light' }), link('u2', 'w', { flow: 'to', rate: 'heavy' })]),
      },
      {
        short: 'Storage',
        chapter: 'technique',
        title: 'Storage is the number that keeps growing',
        body: [
          '20,000 photos × 2 MB = **40 GB a day**. Over a year (call it 400 days to keep it round) that is **16 TB**, and it never shrinks: last year’s photos are still there next year. Add thumbnails at, say, a tenth the size, and the metadata rows, and call it 18 TB a year.',
          'That is far too much for a database, and far too much for one server’s disk. It belongs in **object storage**, which is built for exactly this: cheap, durable, and billed per gigabyte. The files and media lesson covers it.',
        ],
        callout: { kind: 'warn', text: 'Traffic you can scale down when it drops. Storage only ever accumulates. Decide a retention policy on day one, because deleting later is a political problem, not a technical one.' },
        changes: ['+ 40 GB/day', '+ ≈ 16–18 TB/year, cumulative'],
        metrics: { storage: '18 TB' },
        scene: scene([users('u', 1, 1, '20k photos/day'), server('w', 5, 1, 'Photo service'), db('db', 9, 0, 'Database', { sub: 'metadata only' }), cache('os', 9, 2, 'Object storage', { sub: '+40 GB / day', state: 'new' })], [link('u', 'w', { flow: 'to' }), link('w', 'db', { flow: 'to', rate: 'light', label: 'rows' }), link('w', 'os', { flow: 'to', rate: 'heavy', label: 'files' })]),
      },
      {
        short: 'Bandwidth',
        chapter: 'technique',
        title: 'Reads outnumber writes',
        body: [
          'Uploads are writes. Most traffic is people *looking* at photos, and a photo wall is viewed far more often than it is added to. Assume each daily user views 20 photos: 200,000 × 20 = 4 million views a day, **40 per second** on average and **400 per second** at peak.',
          'Serve them at 2 MB each and peak bandwidth is 800 MB/s, which is a lot. Serve resized 200 KB versions and it is 80 MB/s. This is why the service must generate smaller copies at upload time, and why the CDN lesson matters: most of those 400 views a second are of the same few popular photos.',
        ],
        callout: { kind: 'insight', text: 'Write down the read-to-write ratio. Here it is 200:1. A system that is read-heavy is designed around caches and copies; a write-heavy one is designed around queues and partitions.' },
        changes: ['+ 4M views/day, 400/s peak', '~ Resize at upload: 2 MB → 200 KB', '+ Peak bandwidth ≈ 80 MB/s'],
        scene: scene(
          [users('u', 1, 1, '400 views/s', { sub: 'peak, read-heavy' }), cache('cdn', 4, 0, 'CDN', { sub: 'later', state: 'dim' }), server('w', 5, 2, 'Photo service', { sub: 'resizes on upload' }), cache('os', 9, 2, 'Object storage', { sub: '200 KB copies' })],
          [link('u', 'w', { flow: 'from', rate: 'heavy', label: '80 MB/s' }), link('w', 'os', { flow: 'from', rate: 'heavy' }), link('u', 'cdn', { state: 'off', flow: 'none' })],
        ),
      },
      {
        short: 'Numbers to know',
        chapter: 'insight',
        title: 'A handful of numbers worth memorising',
        body: [
          'Estimation goes faster with a few anchors. A day is ~100,000 seconds. A million requests a day is ~12 per second. A modern server handles thousands of simple requests per second, and a single database comfortably does a few thousand small queries per second. A cross-country round trip is ~50–80 ms; across an ocean, ~150 ms. A disk seek is ~10 ms; memory is ~100 ns, a hundred thousand times faster.',
          'With those, the photo wall is clear: peak traffic is small (a single service handles it), storage is large (object storage, with a retention policy), and bandwidth is the risk (resize, then cache).',
        ],
        callout: { kind: 'recap', text: 'State assumptions, convert days to seconds, multiply up for peak, size storage cumulatively, and check the read-to-write ratio. The arithmetic is trivial; the discipline is doing it before designing.' },
        scene: scene([note('n1', 1, 0, '1 day ≈ 10⁵ s'), note('n2', 4, 0, '1M/day ≈ 12/s'), note('n3', 7, 0, 'RTT ocean ≈ 150 ms'), note('n4', 1, 1, 'memory 100 ns'), note('n5', 4, 1, 'SSD read 100 µs'), note('n6', 7, 1, 'disk seek 10 ms'), note('n7', 1, 2, 'server: 1000s req/s'), note('n8', 4, 2, 'DB: 1000s q/s'), note('n9', 7, 2, 'peak ≈ 3–10× avg')]),
      },
    ],
    quiz: [
      q('q1', 'A feature gets 5 million events a day. Roughly what is the average rate per second?', ['About 5 per second', 'About 50 per second', 'About 500 per second'], 1, 'A day is about 100,000 seconds, so 5,000,000 ÷ 100,000 = 50 per second.'),
      q('q2', 'Average traffic is 50 requests a second. What should you size the servers for?', ['50 per second, with a small margin', 'Somewhere between 150 and 500 per second, depending on how spiky the traffic is', 'Exactly 100 per second'], 1, 'Peak is typically 3× to 10× the average, and servers must cope with peak.'),
      q('q3', 'Users upload 10,000 files of 5 MB a day. What is true about storage after a year?', ['About 50 GB, since old files replace new ones', 'About 20 TB, and still growing', 'About 50 GB a day, so it averages out'], 1, '50 GB a day accumulates: around 400 days × 50 GB ≈ 20 TB, and nothing shrinks unless you delete it.'),
    ],
  }),
];
