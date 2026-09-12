/** CLI modes supported by the IOS-style device model. */
export type Mode = 'user' | 'privileged' | 'config' | 'interface' | 'vlan' | 'line' | 'router' | 'acl-std' | 'acl-ext' | 'dhcp';

export type AclAddr = { kind: 'any' } | { kind: 'host'; ip: string } | { kind: 'wildcard'; address: string; wildcard: string };

export type AclProtocol = 'ip' | 'icmp' | 'tcp' | 'udp';

export interface AclEntry {
  seq: number;
  action: 'permit' | 'deny' | 'remark';
  remark?: string;
  /** Extended entries only. */
  protocol?: AclProtocol;
  src: AclAddr;
  dst?: AclAddr;
  srcPort?: number;
  dstPort?: number;
  icmpType?: 'echo' | 'echo-reply';
  established?: boolean;
  matches: number;
}

export interface Acl {
  name: string;
  kind: 'standard' | 'extended';
  entries: AclEntry[];
}

export interface DhcpPool {
  name: string;
  network?: string;
  mask?: string;
  defaultRouter?: string;
  dnsServer?: string;
  domainName?: string;
}

export interface DhcpBinding {
  ip: string;
  mac: string;
  pool: string;
  hostId: string;
}

export interface Ipv6InterfaceConfig {
  /** "ipv6 enable" or any address: the interface gets a link-local address. */
  enabled: boolean;
  addresses: Array<{ address: string; prefix: number; eui64?: boolean }>;
  /** Manually configured link-local ("ipv6 address FE80::1 link-local"); otherwise derived from the MAC. */
  linkLocal?: string;
}

export interface StaticRoute6 {
  prefix: string;
  length: number;
  nextHop?: string;
  exitInterface?: string;
  adminDistance: number;
}

export interface NatStatic {
  insideLocal: string;
  insideGlobal: string;
}

export interface NatPool {
  name: string;
  start: string;
  end: string;
  netmask: string;
}

export interface NatDynamic {
  acl: string;
  pool?: string;
  interface?: string;
  overload: boolean;
}

export interface NatTranslation {
  proto: 'icmp' | 'tcp' | 'udp' | '---';
  insideLocal: string;
  insideLocalPort?: number;
  insideGlobal: string;
  insideGlobalPort?: number;
  outsideGlobal?: string;
  outsidePort?: number;
  static: boolean;
}

export type DeviceType = 'switch' | 'router';

export interface OspfNetworkStatement {
  address: string;
  wildcard: string;
  area: number;
}

/** A single OSPFv2 process ("router ospf <id>"). */
export interface OspfConfig {
  processId: number;
  routerId?: string;
  networks: OspfNetworkStatement[];
  passiveDefault: boolean;
  /** Interfaces made passive explicitly (when passiveDefault is false). */
  passiveInterfaces: string[];
  /** Interfaces un-passived explicitly (when passiveDefault is true). */
  activeInterfaces: string[];
  defaultInformationOriginate: boolean;
}

export interface StaticRoute {
  destination: string;
  mask: string;
  /** Exactly one of nextHop / exitInterface is set. */
  nextHop?: string;
  exitInterface?: string;
  adminDistance: number;
}

/** 'dynamic' is the IOS default (dynamic auto); it behaves as an access port here. */
export type PortMode = 'dynamic' | 'access' | 'trunk';

export interface InterfaceState {
  /** Canonical full name, e.g. "GigabitEthernet0/1" or "Vlan1". */
  name: string;
  description?: string;
  shutdown: boolean;
  /** Physical link present (a host or another device is cabled to this port). */
  connected: boolean;
  mode: PortMode;
  accessVlan: number;
  /** 'all' or an explicit sorted list of VLAN ids. */
  trunkAllowed: 'all' | number[];
  nativeVlan: number;
  ipAddress?: string;
  subnetMask?: string;
  /** Router subinterfaces: "encapsulation dot1Q <vlan> [native]". */
  encapsulation?: { vlan: number; native: boolean };
  /** "ip ospf cost <n>"; default is 1 for Gigabit and loopback interfaces. */
  ospfCost?: number;
  /** "ip ospf priority <n>"; default 1. */
  ospfPriority?: number;
  /** "ip ospf <pid> area <n>" enables OSPF on the interface without a network statement. */
  ospfArea?: number;
  /** "ip access-group <acl> in|out" on routers. */
  aclIn?: string;
  aclOut?: string;
  /** "ip helper-address <server>": relay DHCP toward a server. */
  helperAddress?: string;
  /** "ip nat inside" / "ip nat outside". */
  natRole?: 'inside' | 'outside';
  ipv6?: Ipv6InterfaceConfig;
  /** Member of an EtherChannel: "channel-group <id> mode <mode>". */
  channelGroup?: { id: number; mode: ChannelMode };
  portSecurity?: PortSecurity;
  /** "spanning-tree portfast" (edge port). */
  portfast?: boolean;
  /** "spanning-tree bpduguard enable": err-disable if a switch shows up on the port. */
  bpduGuard?: boolean;
  /** "spanning-tree cost <n>" override (default 4 for Gigabit, 3 for a two-link bundle). */
  stpCost?: number;
  /** Put into err-disabled by a port-security violation; cleared by shutdown / no shutdown. */
  errDisabled?: boolean;
  /** "ip dhcp snooping trust": DHCP server messages may arrive on this port. */
  dhcpSnoopingTrust?: boolean;
  /** "ip arp inspection trust": ARP on this port is not validated against the snooping table. */
  arpInspectionTrust?: boolean;
}

export type ChannelMode = 'on' | 'active' | 'passive' | 'desirable' | 'auto';

export interface PortSecurity {
  enabled: boolean;
  maximum: number;
  violation: 'shutdown' | 'restrict' | 'protect';
  sticky: boolean;
  staticMacs: string[];
  stickyMacs: string[];
  /** Dynamically learned secure addresses (not saved to the config). */
  learnedMacs: string[];
  violations: number;
  lastViolationMac?: string;
}

export interface VlanState {
  id: number;
  name: string;
}

export interface LineState {
  password?: string;
  /** false = no login, true = line password login, 'local' = local user database. */
  login: false | true | 'local';
  transportInput?: 'all' | 'ssh' | 'telnet' | 'none';
  /** "access-class <acl> in" on VTY lines. */
  accessClass?: string;
  /** "exec-timeout <minutes> <seconds>"; IOS default is 10 minutes. */
  execTimeout?: { minutes: number; seconds: number };
}

/** "login block-for <seconds> attempts <tries> within <seconds>". */
export interface LoginBlock {
  seconds: number;
  attempts: number;
  within: number;
}

export type AaaLoginMethod = 'local' | 'local-case' | 'enable' | 'none';

/** Switch-side DHCP snooping ("ip dhcp snooping"). */
export interface DhcpSnooping {
  enabled: boolean;
  vlans: number[];
  /** Insertion of option 82 (on by default in IOS). */
  optionInsert: boolean;
}

export type SnmpMode = 'ro' | 'rw';

export type SyslogLevel = 'emergencies' | 'alerts' | 'critical' | 'errors' | 'warnings' | 'notifications' | 'informational' | 'debugging';

/** One RESTCONF request the device answered, for show output and grading. */
export interface ApiRequest {
  method: 'GET' | 'PATCH' | 'PUT' | 'DELETE' | 'POST';
  path: string;
  status: number;
  user?: string;
}

export interface UserAccount {
  username: string;
  password: string;
  secret: boolean;
  privilege: number;
}

/** A host cabled to one of the switch ports; used for topology, MAC table and ping. */
export interface Neighbor {
  interface: string;
  name: string;
  ip?: string;
  mask?: string;
  mac: string;
  kind: 'pc' | 'server' | 'switch' | 'router';
}

export interface PendingInput {
  kind: 'enable-password';
  attempts: number;
}

export type CliErrorKind = 'invalid' | 'incomplete' | 'ambiguous';

export interface PingRecord {
  target: string;
  success: boolean;
  /** An access list on the way out rejected the packet (ICMP unreachable). */
  denied?: boolean;
}

export interface DeviceState {
  /** Node id inside a NetworkState (defaults to the hostname at creation). */
  id: string;
  deviceType: DeviceType;
  hostname: string;
  mode: Mode;
  currentInterface?: string;
  /** Set by "interface range"; every interface command applies to all of them. */
  currentInterfaces?: string[];
  currentVlan?: number;
  currentLine?: 'con' | 'vty';
  currentAcl?: string;
  currentPool?: string;
  pendingInput?: PendingInput;

  vlans: Record<number, VlanState>;
  interfaces: Record<string, InterfaceState>;
  /**
   * Legacy single-device topology: hosts cabled to this switch. Converted into a
   * NetworkState by fromSwitch(). Multi-device labs use NetworkState links instead.
   */
  neighbors: Neighbor[];

  /** Routers forward between interfaces; switches never do. */
  ipRouting: boolean;
  staticRoutes: StaticRoute[];
  ospf?: OspfConfig;
  acls: Record<string, Acl>;
  dhcpPools: Record<string, DhcpPool>;
  dhcpExcluded: Array<{ from: string; to: string }>;
  dhcpBindings: DhcpBinding[];
  natStatic: NatStatic[];
  natPools: Record<string, NatPool>;
  natDynamic?: NatDynamic;
  natTranslations: NatTranslation[];
  ipv6UnicastRouting: boolean;
  staticRoutes6: StaticRoute6[];
  /** Base MAC address (bridge identifier on switches). */
  mac: string;
  stpMode: 'pvst' | 'rapid-pvst';
  /** "spanning-tree vlan <n> priority <p>" per VLAN; default 32768. */
  stpPriority: Record<number, number>;

  enablePassword?: string;
  enableSecret?: string;
  bannerMotd?: string;
  users: UserAccount[];
  lines: { con: LineState; vty: LineState };
  servicePasswordEncryption: boolean;
  ipDefaultGateway?: string;
  ipDomainName?: string;
  rsaKeyBits?: number;
  sshVersion?: 1 | 2;

  // Security hardening
  /** "security passwords min-length <n>": shorter secrets and passwords are rejected. */
  minPasswordLength?: number;
  loginBlock?: LoginBlock;
  aaaNewModel: boolean;
  /** "aaa authentication login default <methods>" (only with aaa new-model). */
  aaaLoginDefault?: AaaLoginMethod[];
  dhcpSnooping?: DhcpSnooping;
  /** "ip arp inspection vlan <list>". */
  arpInspectionVlans: number[];

  // Management APIs and telemetry
  httpServer: boolean;
  httpSecureServer: boolean;
  /** "ip http authentication local": the API checks the local user database. */
  httpAuthLocal: boolean;
  restconf: boolean;
  netconfYang: boolean;
  apiRequests: ApiRequest[];
  loggingHosts: string[];
  loggingTrap?: SyslogLevel;
  snmpCommunities: Array<{ name: string; mode: SnmpMode }>;
  snmpLocation?: string;
  snmpContact?: string;
  ntpServers: string[];

  /** Text snapshot of the config body at the last save, or null when never saved. */
  startupConfig: string | null;

  /** Raw lines typed by the learner, in order, mistakes included: this is what "show history" prints. */
  commandHistory: string[];
  /**
   * The subset of those lines the CLI actually accepted and ran. Grading reads this
   * so a command the device rejected cannot tick an objective. Optional because a
   * session saved before it existed has no such record; grading falls back to
   * commandHistory for those rather than wiping out progress already made.
   */
  acceptedHistory?: string[];
  /** Fully expanded command forms (e.g. "conf t" -> "configure terminal"), in order. */
  canonicalHistory: string[];
  /** Every mode the learner has been in, for grading. */
  modesVisited: Mode[];
  /** CLI errors the learner has triggered, for "learn from errors" labs. */
  errorsSeen: CliErrorKind[];
  /** Ping attempts from the switch itself. */
  pings: PingRecord[];
}

export interface ExecResult {
  state: DeviceState;
  output: string[];
}
