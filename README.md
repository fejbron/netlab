# NetLab

Open-source network CLI labs that run entirely in your browser. Practise Cisco IOS switch configuration in a simulated terminal, get graded live against lab objectives, and track progress on your device. No installs, no accounts, no payments.

> Status: early MVP. Cisco IOS switches and routers, PCs with a mini terminal, 34 labs across four modules (Meet the CLI, Learn Switching, Secure the Switch, Learn Routing), a faithful command resolver, a packet-forwarding simulation, and a live grader. See the roadmap below.

## Features

- **Realistic IOS CLI**: mode hierarchy (`>`, `#`, `(config)#`, `(config-if)#`, `(config-subif)#`, `(config-vlan)#`, `(config-line)#`), prefix abbreviation (`conf t`, `sh run`), Tab completion, `?` context help, `do` from config mode, and the authentic error messages (`% Invalid input detected at '^' marker.`, `% Incomplete command.`, `% Ambiguous command`).
- **Stateful switch model**: hostname, banner, enable secret, local users, console/VTY lines, VLAN database, access and trunk ports, `interface range`, SVIs, default gateway, SSH keys, password encryption, running vs startup config, and `show` output that matches real formatting.
- **Router model**: routed interfaces, dot1Q subinterfaces, loopbacks, static and default routes with administrative distance, and an IOS 15 style `show ip route` with connected, local and static routes grouped by classful network.
- **Multi-device topologies with real forwarding**: labs can hold several switches, routers and PCs. `ping` and `traceroute` walk frames through switches (access, trunk, native and allowed VLANs, router subinterface tags) and route packets hop by hop, and only succeed when the reply can get back too.
- **PC terminal**: `ipconfig`, `ping` and `tracert` with Windows-style output, so learners test from the host like they would on the job.
- **Labs with live grading**: objectives are declarative checks on device state, command history and ping results, scoped to any device in the topology. The sidebar ticks off objectives as you type.
- **Progress and sessions on device**: everything is stored in `localStorage`. Nothing leaves your browser.

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
  components/, pages/  React UI (dashboard, lab page, terminal, topology)
  lib/                 localStorage progress and per-lab session persistence
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

Every check accepts an optional `device` (a device id, or a host id for `ping`); it defaults to the network's primary device. Available check types: `command` (regex over the expanded command history), `mode`, `hostname`, `vlan-exists`, `vlan-absent`, `interface`, `enable-secret`, `enable-password`, `line`, `user`, `banner`, `domain-name`, `ssh-ready`, `default-gateway`, `saved`, `password-encryption`, `error-seen`, `ping`, `route`, `route-absent`. See `src/engine/grader.ts`.

Add the lab to a module file in `src/content/labs/` and add a reference solution to `src/engine/grader.test.ts` so it stays green.

## Roadmap

- [x] Router model: routed interfaces, static routes, `show ip route`, inter-VLAN routing
- [x] Multi-device labs with a PC terminal and frame forwarding between devices
- [ ] Dynamic routing (single-area OSPF) and DHCP
- [ ] More vendors through the adapter pattern (JunOS, Arista EOS, Aruba CX)
- [ ] Sandbox topology editor
- [ ] Markdown lab format and a lab authoring page
- [ ] Optional export/import of progress as a file

## Contributing

Issues and pull requests are welcome. Keep the engine free of React, add tests for any new command, and write original lab text.

## License

MIT. Cisco and IOS are trademarks of Cisco Systems, Inc. NetLab is an independent educational simulator and is not affiliated with or endorsed by Cisco.
