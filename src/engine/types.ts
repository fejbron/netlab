/** CLI modes supported by the IOS-style device model. */
export type Mode = 'user' | 'privileged' | 'config' | 'interface' | 'vlan' | 'line';

export type DeviceType = 'switch' | 'router';

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

  /** Text snapshot of the config body at the last save, or null when never saved. */
  startupConfig: string | null;

  /** Raw lines typed by the learner, in order. */
  commandHistory: string[];
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
