# NetLab

[![CI](https://github.com/fejbron/netlab/actions/workflows/ci.yml/badge.svg)](https://github.com/fejbron/netlab/actions/workflows/ci.yml)

Open-source network CLI labs that run entirely in your browser. Practise Cisco IOS switch configuration in a simulated terminal, get graded live against lab objectives, and track progress on your device. No installs, no accounts, no payments.

> Status: early MVP. Cisco IOS switches and routers, PCs with a mini terminal, 91 labs across fourteen modules (Meet the CLI, Learn Switching, Learn EtherChannel, Learn Spanning Tree, Secure the Switch, Learn Routing, Learn OSPF, Learn ACLs, Learn DHCP, Learn NAT, Learn IPv6, Learn Network Security, Learn Automation & AI Network Operations, CCNA Exams), a faithful command resolver, a packet-forwarding simulation with per-VLAN spanning tree, multi-area OSPF, enforced access lists, DHCP, NAT, IPv6, EtherChannel, port security, DHCP snooping and dynamic ARP inspection, a RESTCONF API reachable with `curl` from the PC terminal, and a live grader. Labs unlock in order. See the roadmap below.

## Features

- **Realistic IOS CLI**: mode hierarchy (`>`, `#`, `(config)#`, `(config-if)#`, `(config-subif)#`, `(config-vlan)#`, `(config-line)#`), prefix abbreviation (`conf t`, `sh run`), Tab completion, `?` context help, `do` from config mode, and the authentic error messages (`% Invalid input detected at '^' marker.`, `% Incomplete command.`, `% Ambiguous command`).
- **Stateful switch model**: hostname, banner, enable secret, local users, console/VTY lines, VLAN database, access and trunk ports, `interface range`, SVIs, default gateway, SSH keys, password encryption, running vs startup config, and `show` output that matches real formatting.
- **EtherChannel**: `channel-group` with LACP (active/passive), PAgP (desirable/auto) and static (on) modes, `interface Port-channel` whose settings flow to member ports, negotiation rules evaluated from both ends of each link, members flagged P/I/s/D, and `show etherchannel summary`.
- **Spanning tree**: per-VLAN root election by bridge ID (priority + MAC), root path cost, root/designated/alternate port roles with the loop-breaking ports blocked in the forwarding simulation (so the network reconverges when a link fails or the root moves), `spanning-tree vlan N priority` and `root primary`/`secondary`, `spanning-tree mode pvst|rapid-pvst`, per-port `cost`, PortFast and BPDU guard (which err-disables a port that faces a switch), and IOS-style `show spanning-tree [vlan N]`.
- **Port security**: `switchport port-security` with maximum, static and sticky addresses and shutdown/restrict/protect violation modes, enforced when a PC sends traffic. Violations err-disable the port (or drop frames), `shutdown` / `no shutdown` recovers it, and `show port-security` (interface and address) reports the state.
- **Progression**: labs unlock in order, so passing the last lab of a module opens the next module.
- **Learning path dashboard**: a "continue your course" card picks the next lab (an unfinished session first, then the next open lab), a sticky stage navigator shows a progress ring per module, and every lab row reports its status (not started, *n of m objectives* from the saved console, completed) with a Begin / Resume / Replay action. Stars are explained in place: 3 for a pass with no hints, 2 with some, 1 with all of them.
- **CCNA 200-301 v1.1 exam blueprint**: each module is tagged with the blueprint topics it practises (`examTopics` in `src/content/index.ts`, described in `src/content/blueprint.ts`). The dashboard lists Cisco's six exam domains with their published weighting, the labs that cover each one, and the learner's progress per domain, and says plainly which domains NetLab does not cover yet.
- **Router model**: routed interfaces, dot1Q subinterfaces, loopbacks, static and default routes with administrative distance, and an IOS 15 style `show ip route` with connected, local, static and OSPF routes grouped by classful network.
- **OSPF**: `router ospf`, router IDs (configured or elected from loopbacks and interfaces), `network` statements with wildcard masks and areas, `ip ospf <pid> area`, passive interfaces, interface cost and priority, DR/BDR election per segment, neighbours only when area and subnet match, SPF over the router graph with accumulated metrics, administrative distance 110, and `default-information originate` producing O*E2 defaults. Multi-area: intra-area SPF per area (`O`), inter-area routes learned through area border routers attached to the backbone (`O IA`), intra-area preferred over inter-area, and an area with no path to area 0 stays isolated. `show ip ospf neighbor`, `show ip ospf interface brief`, `show ip ospf`, `show ip protocols`, `show ip route ospf`.
- **Multi-device topologies with real forwarding**: labs can hold several switches, routers and PCs. `ping` and `traceroute` walk frames through switches (access, trunk, native and allowed VLANs, router subinterface tags) and route packets hop by hop, and only succeed when the reply can get back too.
- **Access lists**: standard and extended, numbered and named, with `host`, `any`, wildcards, `eq` ports (names or numbers), ICMP `echo`/`echo-reply`, sequence numbers and remarks. Applied with `ip access-group in|out` on router interfaces and `access-class` on VTY lines. Enforced in the forwarding simulation: a denied echo answers `U.U.U` on IOS and "Destination net unreachable" on a PC, a filtered reply times out, router-originated traffic bypasses outbound lists, and `show access-lists` counts matches.
- **DHCP**: `ip dhcp pool` with `network`, `default-router`, `dns-server`, excluded addresses, relay with `ip helper-address`, bindings, `show ip dhcp binding` and `show ip dhcp pool`. PCs marked as DHCP clients obtain leases with `ipconfig /renew` (local server first, then a reachable relay target) and drop them with `ipconfig /release`.
- **NAT**: `ip nat inside`/`outside` roles, static NAT, dynamic NAT with pools, PAT with a pool or an interface (`overload`), `show ip nat translations` and `statistics`, `clear ip nat translation *`. Translation happens in the forwarding simulation: sources are rewritten when crossing from inside to outside, replies to global addresses map back, the outside interface answers ARP for static globals and pool addresses, router-originated traffic is not translated, and a pool without `overload` runs out.
- **IPv6**: `ipv6 unicast-routing`, global addresses with prefix lengths, EUI-64, automatic and manual link-local addresses, `ipv6 enable`, static and default routes (including link-local next hops with an exit interface), `show ipv6 interface brief`, `show ipv6 route`, and IPv6 `ping`/`traceroute` from routers and PCs over the same forwarding engine. Hosts can be dual-stack.
- **Network security**: `security passwords min-length` rejects short secrets with the real IOS message, `login block-for`, per-line `exec-timeout`, `aaa new-model` with `aaa authentication login default local`, and `show login`. On switches, DHCP snooping (`ip dhcp snooping [vlan]`, `ip dhcp snooping trust`, option 82 control) is enforced in the DHCP simulation: an offer that arrives on an untrusted port is dropped, so a client cannot lease until the uplink is trusted. Dynamic ARP inspection (`ip arp inspection vlan`, `ip arp inspection trust`) silences a host on an untrusted port unless it holds a DHCP snooping binding, which is exactly what happens to a static server in the real world. `show ip dhcp snooping [binding]`, `show ip arp inspection [vlan N | interfaces]`.
- **Automation and AI network operations**: `ip http secure-server`, `ip http authentication local`, `restconf` and `netconf-yang` on every device, `show platform software yang-management process`, and a small RESTCONF server that speaks the `ietf-interfaces` and `Cisco-IOS-XE-native` models (GET, PATCH, PUT). Telemetry: `logging host` and `logging trap`, `snmp-server community | location | contact`, `ntp server`, with `show logging`, `show snmp community`, `show ntp status` (synchronised only when the server is reachable) and `show ntp associations`. Labs cover reading a device as JSON, pushing a change through the API, deploying from a JSON intent, feeding telemetry to an AI operations platform, and reviewing an AI-proposed change before trusting it.
- **PC terminal**: `ipconfig` (with `/all`, `/renew`, `/release`), `ping` and `tracert` (IPv4 and IPv6) with Windows-style output, and `curl` (`-k`, `-u`, `-X`, `-H`, `-d`, `-i`) against a router's RESTCONF API with realistic failures (connection refused, self-signed certificate, 401, 404, 400 for malformed JSON, 204 on a successful write), so learners test from the host like they would on the job.
- **Labs with live grading**: objectives are declarative checks on device state, command history and ping results, scoped to any device in the topology. The sidebar ticks off objectives as you type.
- **Accounts**: when the site operator enables accounts (see below), learners must sign in, with email and password or GitHub, before starting a lab. Their best score and stars per lab are stored server-side and follow them across devices; the lab list and leaderboard stay visible to visitors. A copy deployed without a Supabase project runs in guest mode instead: no sign-in, progress in `localStorage`, nothing leaves the browser.
- **Leaderboard**: with accounts enabled, `/leaderboard` ranks learners by total stars (then labs passed, then who got there first). Each learner has a public display name, defaulting to their GitHub user name or the part of their email before the @, editable on the account page, and can opt out of the board. Emails are never shown.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

```bash
npm test          # engine and lab tests (vitest)
npm run build     # type-check and build to dist/
```

## Accounts (optional)

NetLab works without any backend. To let learners create accounts and keep progress across devices, point it at a free [Supabase](https://supabase.com) project:

1. Create a Supabase project and apply `supabase/schema.sql`, either by pasting it into the dashboard's SQL editor or from the command line with the Supabase CLI (no database password needed, it goes through the management API after a browser login):

   ```bash
   npx supabase@2 login
   npx supabase@2 db query --linked --project-ref <your-project-ref> -f supabase/schema.sql
   ```

   It creates the `lab_progress` table with row-level security, so each learner can only read and write their own rows, plus a `profiles` table (public display name, leaderboard opt-out, filled in automatically when an account is created) and the `leaderboard` view, which totals stars across learners without exposing anyone's individual rows. The file is safe to re-run after upgrades.
2. In Authentication > Providers, keep Email enabled. Optionally enable GitHub and add your site URL under Authentication > URL Configuration (add `http://localhost:5173` for local development, and `/account` as an allowed redirect path).
3. Copy the project URL and the anon (public) key from Project Settings > API into a `.env.local` file (see `.env.example`):

   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```

4. Restart `npm run dev`. A "Sign in" button appears in the header and `/account` offers sign-in and account creation.

The anon key is safe to ship in the browser bundle: every request runs under the signed-in user's JWT and the row-level security policies decide what it may touch. Terminal sessions (the text of each lab's console) stay on the device; only scores, stars and completion times are stored in the account.

## Deploying to Vercel

The app is a static site, so the free tier is enough. Import the repository in Vercel; it detects Vite and uses `npm run build` with `dist/` as the output directory. `vercel.json` rewrites every path to `index.html` so deep links like `/lab/os-01-turn-on-ospf` work on refresh. To enable accounts, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables in the project settings and redeploy. Any other static host (Netlify, Cloudflare Pages, GitHub Pages) works the same way as long as it serves `index.html` for unknown paths.

## Design

Dark theme built on the Catppuccin Mocha palette with a mauve accent (tokens in `src/index.css`). Headings, labels, the terminal and all icons use a self-hosted [JetBrainsMono Nerd Font](https://www.nerdfonts.com/) (`public/fonts/`, WOFF2); prose uses Inter. Icons are Nerd Font glyphs rendered through `src/components/Icon.tsx`, so no icon library is needed.

## Project layout

```
src/
  engine/              Pure TypeScript, no React. Fully unit-tested.
    resolver.ts        Prefix-matching command resolver, help and Tab completion
    ios/commands.ts    Command tables per mode for switches and routers
    ios/device.ts      executeOn(network, nodeId, line); prompt(); createSwitch(); createRouter()
    ios/show.ts        Renderers for show commands, running config and show ip route
    network.ts         NetworkState (devices, hosts, links), routing tables, ping/traceroute simulation
    host.ts            PC terminal (ipconfig, ping, tracert)
    grader.ts          Declarative checks and grade(objectives, network)
  content/
    labs/*.ts          Lab definitions (scenario, hints, initial device, objectives)
    blueprint.ts       CCNA 200-301 exam domains, weights, topic titles and per-domain coverage
  components/, pages/  React UI (dashboard, lab page, terminal, topology)
  lib/                 progress (localStorage + optional Supabase sync), auth, per-lab session persistence,
                       pathProgress (lab status, next action, star levels)
supabase/schema.sql    optional database schema for accounts
```

## Writing a lab

A lab is a plain object. The starting device comes from `createSwitch()`, and objectives are lists of checks:

```ts
{
  id: 'sw-01-create-vlans',
  moduleId: 'learn-switching',
  order: 1,
  title: 'Create VLANs',
  difficulty: 'Beginner',
  estimatedMinutes: 6,
  description: 'Create and name two VLANs.',
  scenario: 'The branch office is splitting its network...',
  concepts: ['VLAN database'],
  hints: ['VLANs are created in global configuration mode with vlan 10.'],
  createState: () => createSwitch({ hostname: 'Access-SW1', ports: 6, neighbors: [...] }),
  objectives: [
    { id: 'v10', label: 'Create VLAN 10 named SALES', checks: [{ type: 'vlan-exists', id: 10, name: 'SALES' }] },
    { id: 'verify', label: 'Verify', checks: [{ type: 'command', pattern: '^(do )?show vlan brief$' }] },
  ],
}
```

Multi-device labs return a network instead of a switch:

```ts
createState: () =>
  buildNetwork({
    primary: 'R1',
    devices: [createRouter({ hostname: 'R1' }), createRouter({ hostname: 'R2', interfaces: { 'g0/1': { ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } } })],
    hosts: [{ id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1']],
  }),
```

Every check accepts an optional `device` (a device id, or a host id for `ping`); it defaults to the network's primary device. Available check types: `command` (regex over the expanded command history), `mode`, `hostname`, `vlan-exists`, `vlan-absent`, `interface`, `enable-secret`, `enable-password`, `line`, `user`, `banner`, `domain-name`, `ssh-ready`, `default-gateway`, `saved`, `password-encryption`, `error-seen`, `ping`, `route`, `route-absent`, `learned-route`, `ospf`, `ospf-network`, `ospf-network-absent`, `ospf-neighbors`, `passive-interface`, `default-information-originate`, `trunk-allows`, `acl-exists`, `acl-entry`, `acl-applied`, `acl-not-applied`, `access-class`, `dhcp-pool`, `dhcp-excluded`, `dhcp-bindings`, `helper-address`, `host-config`, `nat-role`, `nat-static`, `nat-pool`, `nat-dynamic`, `nat-translations`, `ipv6-unicast-routing`, `ipv6-address`, `route6`, `etherchannel`, `port-security`, `stp-root`, `stp-priority`, `stp-mode`, `stp-port`, `password-policy`, `exec-timeout`, `aaa`, `dhcp-snooping`, `port-trust`, `arp-inspection`, `management-api`, `api-request`, `syslog`, `snmp-community`, `ntp-server`. See `src/engine/grader.ts`.

Add the lab to a module file in `src/content/labs/` and add a reference solution to `src/engine/grader.test.ts` so it stays green. A new module also needs `examTopics` (200-301 topic codes such as `'3.4'`) in `src/content/index.ts`; any code not yet described in `src/content/blueprint.ts` must be added there, and the blueprint test enforces both.

## Roadmap

- [x] Router model: routed interfaces, static routes, `show ip route`, inter-VLAN routing
- [x] Multi-device labs with a PC terminal and frame forwarding between devices
- [x] Single-area OSPF
- [x] Access control lists enforced in the forwarding simulation
- [x] DHCP server and relay
- [x] NAT (static, dynamic, PAT) and IPv6 addressing with static routing
- [x] EtherChannel (LACP, PAgP, static) and port security
- [x] Multi-area OSPF and per-VLAN spanning tree (root election, blocked ports, PortFast, BPDU guard)
- [x] Network security: password policy, AAA, DHCP snooping and dynamic ARP inspection enforced in the simulation
- [x] Automation: RESTCONF and NETCONF enablement, `curl` from the PC against a simulated RESTCONF API, syslog/SNMP/NTP telemetry
- [ ] OSPFv3, SLAAC and DHCPv6, IPv6 access lists
- [ ] ARP access lists for DAI, DHCP snooping rate limits with err-disable, 802.1X port authentication
- [ ] NETCONF sessions from the PC, RESTCONF for ACLs and routes, a sandbox JSON viewer
- [ ] Layer 3 EtherChannel, MST, route summarisation on ABRs
- [ ] More vendors through the adapter pattern (JunOS, Arista EOS, Aruba CX)
- [ ] Sandbox topology editor
- [ ] Markdown lab format and a lab authoring page
- [ ] Optional export/import of progress as a file

## Contributing

Issues and pull requests are welcome. Keep the engine free of React, add tests for any new command, and write original lab text.

## License

MIT. Cisco and IOS are trademarks of Cisco Systems, Inc. NetLab is an independent educational simulator and is not affiliated with or endorsed by Cisco.
