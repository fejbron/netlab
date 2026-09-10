import { buildNetwork, createSwitch, type ChannelMode, type NetworkState } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'learn-etherchannel';

/**
 * Two access switches joined by two parallel links (g0/7 and g0/8 on both sides).
 * PC-A (VLAN 10) and PC-B (VLAN 20) on SW1; PC-C (VLAN 10) and PC-D (VLAN 20) on SW2.
 * SW2 is prepared as the lab requires; SW1 is the learner's switch.
 */
function twoSwitches(opts: { sw1Mode?: ChannelMode; sw2Mode: ChannelMode; sw1Trunk?: boolean }): NetworkState {
  const make = (hostname: string, mode: ChannelMode | undefined, poTrunk: boolean) =>
    createSwitch({
      hostname,
      ports: 8,
      vlans: [{ id: 10, name: 'SALES' }, { id: 20, name: 'HR' }],
      interfaces: {
        'g0/1': { mode: 'access', accessVlan: 10, description: 'Sales PC' },
        'g0/2': { mode: 'access', accessVlan: 20, description: 'HR PC' },
        'g0/7': { description: 'Link 1 to peer switch', ...(mode ? { channelGroup: { id: 1, mode }, mode: poTrunk ? 'trunk' : 'dynamic' } : {}) },
        'g0/8': { description: 'Link 2 to peer switch', ...(mode ? { channelGroup: { id: 1, mode }, mode: poTrunk ? 'trunk' : 'dynamic' } : {}) },
        ...(mode ? { po1: { mode: poTrunk ? 'trunk' : 'dynamic' } } : {}),
      },
    });
  return buildNetwork({
    primary: 'SW1',
    devices: [make('SW1', opts.sw1Mode, opts.sw1Trunk ?? false), make('SW2', opts.sw2Mode, true)],
    hosts: [
      { id: 'PC-A', ip: '192.168.10.11', mask: '255.255.255.0' },
      { id: 'PC-B', ip: '192.168.20.11', mask: '255.255.255.0' },
      { id: 'PC-C', ip: '192.168.10.12', mask: '255.255.255.0' },
      { id: 'PC-D', ip: '192.168.20.12', mask: '255.255.255.0' },
    ],
    links: [['PC-A', 'SW1:g0/1'], ['PC-B', 'SW1:g0/2'], ['PC-C', 'SW2:g0/1'], ['PC-D', 'SW2:g0/2'], ['SW1:g0/7', 'SW2:g0/7'], ['SW1:g0/8', 'SW2:g0/8']],
  });
}

export const learnEtherchannelLabs: Lab[] = [
  {
    id: 'ec-01-lacp-bundle',
    moduleId: MODULE,
    order: 1,
    title: 'Bundle Two Links With LACP',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Turn two parallel uplinks into one logical Port-channel trunk using LACP.',
    scenario:
      'SW1 and SW2 are cabled together twice, on g0/7 and g0/8, to get more bandwidth between the floors. SW2 is ready: both of its ports are in channel-group 1 with LACP active and Port-channel 1 is a trunk.\n\nOn SW1, put g0/7 and g0/8 into channel-group 1 using LACP active mode, then configure interface Port-channel 1 as a trunk. Confirm with show etherchannel summary that Po1 shows (SU) with both ports (P), and prove that PC-A reaches PC-C across the bundle.',
    concepts: ['EtherChannel', 'LACP active/passive', 'channel-group', 'interface Port-channel', 'show etherchannel summary'],
    hints: [
      'interface range g0/7 - 8, then channel-group 1 mode active. IOS creates Port-channel 1 for you.',
      'interface port-channel 1, switchport mode trunk. Settings on the Port-channel flow down to the member ports.',
      'show etherchannel summary: Po1(SU) means the channel is Layer 2 and in use; Gi0/7(P) means bundled.',
      'From PC-A, ping 192.168.10.12.',
    ],
    createState: () => twoSwitches({ sw2Mode: 'active' }),
    objectives: [
      { id: 'group', label: 'Put g0/7 and g0/8 in channel-group 1 with LACP', checks: [{ type: 'etherchannel', group: 1, members: ['g0/7', 'g0/8'], protocol: 'LACP', label: 'Group 1 contains g0/7 and g0/8 using LACP' }] },
      { id: 'trunk', label: 'Make Port-channel 1 a trunk', checks: [{ type: 'etherchannel', group: 1, mode: 'trunk', label: 'Port-channel 1 is in trunk mode' }] },
      { id: 'bundled', label: 'The channel forms', checks: [{ type: 'etherchannel', group: 1, bundled: true, label: 'Po1 is (SU) with bundled ports' }, { type: 'command', pattern: '^(do )?show etherchannel( \\d+)? summary$' }] },
      { id: 'ping', label: 'Traffic crosses the bundle', checks: [{ type: 'ping', device: 'PC-A', target: '192.168.10.12', success: true, label: 'PC-A pings PC-C' }] },
    ],
  },
  {
    id: 'ec-02-channel-never-forms',
    moduleId: MODULE,
    order: 2,
    title: 'Troubleshoot: The Channel That Never Forms',
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Both switches have channel-group 1, yet the summary shows stand-alone ports. Find the mode mismatch.',
    scenario:
      'A colleague configured EtherChannel on both switches yesterday. Today show etherchannel summary on SW1 shows Po1(SD) and every port flagged (I) for stand-alone.\n\nLACP needs at least one side to actively negotiate. Compare the channel-group modes on both switches, fix SW1 only, and confirm the bundle comes up.',
    concepts: ['LACP negotiation', 'passive + passive never bundles', 'Reading (I) and (SD) flags'],
    hints: [
      'show etherchannel summary on both switches. Both sides say LACP but the ports are (I).',
      'show running-config on SW1: g0/7 and g0/8 use channel-group 1 mode passive. So does SW2. Passive waits for the other side to speak first.',
      'interface range g0/7 - 8, channel-group 1 mode active. Re-check the summary: Po1(SU), ports (P).',
    ],
    createState: () => twoSwitches({ sw1Mode: 'passive', sw2Mode: 'passive', sw1Trunk: true }),
    objectives: [
      { id: 'inspect', label: 'Inspect the channel', checks: [{ type: 'command', pattern: '^(do )?show etherchannel( \\d+)? summary$' }] },
      { id: 'fix', label: 'Make SW1 negotiate actively', checks: [{ type: 'etherchannel', group: 1, protocol: 'LACP', bundled: true, label: 'Po1 is bundled over LACP' }] },
      { id: 'keep', label: 'Keep the trunk', checks: [{ type: 'etherchannel', group: 1, mode: 'trunk', members: ['g0/7', 'g0/8'], label: 'Po1 still trunks with both members' }] },
    ],
  },
  {
    id: 'ec-03-pagp-and-static',
    moduleId: MODULE,
    order: 3,
    title: "PAgP: Cisco's Own Bundle",
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'Build the same bundle with PAgP desirable/auto and learn which mode pairs work.',
    scenario:
      'The floor switches are being standardised on PAgP. SW2 is already set to channel-group 1 mode auto with Port-channel 1 as a trunk. Auto only responds, so SW1 must ask.\n\nConfigure SW1 g0/7 and g0/8 with channel-group 1 in the PAgP mode that initiates negotiation, make Port-channel 1 a trunk, and verify the summary shows PAgP with bundled ports. Then confirm PC-B can reach PC-D.',
    concepts: ['PAgP desirable/auto', 'Compatible mode pairs', 'Protocol column in show etherchannel summary'],
    hints: [
      'PAgP modes are desirable (initiates) and auto (responds). Auto with auto never bundles.',
      'interface range g0/7 - 8, channel-group 1 mode desirable.',
      'interface port-channel 1, switchport mode trunk. Then show etherchannel summary shows PAgP.',
    ],
    createState: () => twoSwitches({ sw2Mode: 'auto' }),
    objectives: [
      { id: 'group', label: 'Bundle with PAgP desirable', checks: [{ type: 'etherchannel', group: 1, protocol: 'PAgP', bundled: true, members: ['g0/7', 'g0/8'], label: 'Po1 is bundled over PAgP with both ports' }] },
      { id: 'trunk', label: 'Trunk on the Port-channel', checks: [{ type: 'etherchannel', group: 1, mode: 'trunk', label: 'Port-channel 1 is a trunk' }] },
      { id: 'verify', label: 'Verify the summary', checks: [{ type: 'command', pattern: '^(do )?show etherchannel( \\d+)? summary$' }] },
      { id: 'ping', label: 'HR crosses the bundle', checks: [{ type: 'ping', device: 'PC-B', target: '192.168.20.12', success: true, label: 'PC-B pings PC-D' }] },
    ],
  },
];
