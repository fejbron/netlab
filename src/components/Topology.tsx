import { interfaceStatus, isLoopback, isSubinterface, isSvi, shortInterfaceName, compareInterfaceNames, type NetworkState } from '../engine';

interface Props {
  network: NetworkState;
  active: string;
  onSelect: (id: string) => void;
}

interface NodeBox {
  id: string;
  title: string;
  subtitle: string;
  detail: string;
  kind: 'router' | 'switch' | 'host';
  x: number;
  y: number;
}

function layout(network: NetworkState, width: number): NodeBox[] {
  const rows: NodeBox[][] = [[], [], []];
  for (const d of Object.values(network.devices)) {
    const row = d.deviceType === 'router' ? 0 : 1;
    rows[row].push({ id: d.id, title: d.hostname, subtitle: d.deviceType.toUpperCase(), detail: '', kind: d.deviceType, x: 0, y: 0 });
  }
  for (const h of Object.values(network.hosts)) {
    rows[2].push({ id: h.id, title: h.name, subtitle: h.deviceKind.toUpperCase(), detail: h.ip ?? h.ip6 ?? (h.dhcp ? 'DHCP' : ''), kind: 'host', x: 0, y: 0 });
  }
  const present = rows.filter((r) => r.length > 0);
  const rowHeight = 90;
  present.forEach((row, ri) => {
    row.forEach((n, i) => {
      n.x = row.length === 1 ? width / 2 : 70 + (i * (width - 140)) / (row.length - 1);
      n.y = 40 + ri * rowHeight;
    });
  });
  return present.flat();
}

export default function Topology({ network, active, onSelect }: Props) {
  const count = Object.keys(network.devices).length + Object.keys(network.hosts).length;
  const width = Math.max(320, Math.min(520, count * 90));
  const nodes = layout(network, width);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rowsUsed = new Set(nodes.map((n) => n.y)).size;
  const height = 60 + rowsUsed * 90;

  const device = network.devices[active];
  const host = network.hosts[active];

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-surface p-3">
        <h2 className="mb-1 text-sm font-semibold text-fg-bright">Topology</h2>
        <p className="mb-1 text-[11px] text-muted">Click a device to open its terminal.</p>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Network topology">
          {network.links.map((l, i) => {
            const a = byId.get(l.a.node);
            const b = byId.get(l.b.node);
            if (!a || !b) return null;
            const aDev = network.devices[l.a.node];
            const bDev = network.devices[l.b.node];
            const up = (!aDev || !aDev.interfaces[l.a.iface]?.shutdown) && (!bDev || !bDev.interfaces[l.b.iface]?.shutdown);
            const labelA = aDev ? shortInterfaceName(l.a.iface) : '';
            const labelB = bDev ? shortInterfaceName(l.b.iface) : '';
            return (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={up ? 'stroke-success' : 'stroke-danger'} strokeWidth={1.5} strokeDasharray={up ? undefined : '4 3'} />
                {labelA && (
                  <text x={a.x + (b.x - a.x) * 0.22} y={a.y + (b.y - a.y) * 0.22 - 3} textAnchor="middle" className="fill-muted text-[8px] font-mono">
                    {labelA}
                  </text>
                )}
                {labelB && (
                  <text x={a.x + (b.x - a.x) * 0.78} y={a.y + (b.y - a.y) * 0.78 - 3} textAnchor="middle" className="fill-muted text-[8px] font-mono">
                    {labelB}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => {
            const isActive = n.id === active;
            const fill = n.kind === 'router' ? 'fill-warning/15' : n.kind === 'switch' ? 'fill-accent-soft' : 'fill-surface-2';
            const stroke = isActive ? 'stroke-accent' : n.kind === 'router' ? 'stroke-warning/60' : n.kind === 'switch' ? 'stroke-accent/60' : 'stroke-border';
            return (
              <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="cursor-pointer" onClick={() => onSelect(n.id)} role="button" aria-label={`Open ${n.title}`}>
                <rect x={-48} y={-26} width={96} height={52} rx={n.kind === 'router' ? 26 : 8} className={`${fill} ${stroke}`} strokeWidth={isActive ? 2 : 1} />
                <text y={-7} textAnchor="middle" className="fill-fg-bright text-[11px] font-semibold">
                  {n.title}
                </text>
                <text y={6} textAnchor="middle" className="fill-muted text-[9px]">
                  {n.subtitle}
                </text>
                <text y={19} textAnchor="middle" className="fill-fg text-[9px] font-mono">
                  {n.detail}
                </text>
              </g>
            );
          })}
        </svg>
      </section>

      {device && device.deviceType === 'switch' && (
        <section className="rounded-xl border border-border bg-surface p-3">
          <h2 className="mb-2 text-sm font-semibold text-fg-bright">{device.hostname} interfaces</h2>
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="pb-1 font-medium">Port</th>
                <th className="pb-1 font-medium">Mode</th>
                <th className="pb-1 font-medium">VLAN</th>
                <th className="pb-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {Object.values(device.interfaces)
                .sort((a, b) => compareInterfaceNames(a.name, b.name))
                .map((i) => {
                  if (isSvi(i.name)) {
                    return (
                      <tr key={i.name} className="border-t border-border/60">
                        <td className="py-1 text-fg-bright">{i.name}</td>
                        <td className="py-1">svi</td>
                        <td className="py-1">{i.ipAddress ?? '—'}</td>
                        <td className={`py-1 ${i.shutdown ? 'text-danger' : 'text-success'}`}>● {i.shutdown ? 'disabled' : 'up'}</td>
                      </tr>
                    );
                  }
                  const status = interfaceStatus(i);
                  const color = status === 'connected' ? 'text-success' : status === 'disabled' ? 'text-danger' : 'text-muted';
                  return (
                    <tr key={i.name} className="border-t border-border/60">
                      <td className="py-1 text-fg-bright">{shortInterfaceName(i.name)}</td>
                      <td className="py-1">{i.mode}</td>
                      <td className="py-1">{i.mode === 'trunk' ? 'trunk' : i.accessVlan}</td>
                      <td className={`py-1 ${color}`}>● {status}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>
      )}

      {device && device.deviceType === 'router' && (
        <section className="rounded-xl border border-border bg-surface p-3">
          <h2 className="mb-2 text-sm font-semibold text-fg-bright">{device.hostname} interfaces</h2>
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="pb-1 font-medium">Interface</th>
                <th className="pb-1 font-medium">IP address</th>
                <th className="pb-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {Object.values(device.interfaces)
                .sort((a, b) => compareInterfaceNames(a.name, b.name))
                .map((i) => {
                  const up = !i.shutdown && (i.connected || isLoopback(i.name) || isSubinterface(i.name));
                  const status = i.shutdown ? 'admin down' : up ? 'up' : 'down';
                  const color = i.shutdown ? 'text-danger' : up ? 'text-success' : 'text-muted';
                  return (
                    <tr key={i.name} className="border-t border-border/60">
                      <td className="py-1 text-fg-bright">{shortInterfaceName(i.name)}</td>
                      <td className="py-1">
                        {i.ipAddress ? `${i.ipAddress}` : i.ipv6?.addresses[0] ? `${i.ipv6.addresses[0].address}/${i.ipv6.addresses[0].prefix}` : '—'}
                        {i.encapsulation ? <span className="text-muted"> dot1q {i.encapsulation.vlan}</span> : null}
                        {i.natRole ? <span className="text-muted"> nat {i.natRole}</span> : null}
                      </td>
                      <td className={`py-1 ${color}`}>● {status}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          {device.staticRoutes.length > 0 && (
            <div className="mt-3">
              <h3 className="mb-1 text-xs font-semibold text-fg-bright">Static routes</h3>
              <ul className="font-mono text-xs text-fg">
                {device.staticRoutes.map((r, i) => (
                  <li key={i}>
                    {r.destination} {r.mask} → {r.nextHop ?? r.exitInterface}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {host && (
        <section className="rounded-xl border border-border bg-surface p-3">
          <h2 className="mb-2 text-sm font-semibold text-fg-bright">{host.name}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <dt className="text-muted">IPv4</dt>
            <dd className="text-fg-bright">{host.ip ?? '—'}</dd>
            <dt className="text-muted">Mask</dt>
            <dd className="text-fg-bright">{host.mask ?? '—'}</dd>
            <dt className="text-muted">Gateway</dt>
            <dd className="text-fg-bright">{host.gateway ?? '—'}</dd>
            {host.ip6 && (
              <>
                <dt className="text-muted">IPv6</dt>
                <dd className="text-fg-bright">
                  {host.ip6}/{host.prefix6}
                </dd>
                <dt className="text-muted">Gateway v6</dt>
                <dd className="text-fg-bright">{host.gateway6 ?? '—'}</dd>
              </>
            )}
            {host.dns && (
              <>
                <dt className="text-muted">DNS</dt>
                <dd className="text-fg-bright">{host.dns}</dd>
              </>
            )}
            {host.dhcp && (
              <>
                <dt className="text-muted">DHCP</dt>
                <dd className="text-fg-bright">{host.dhcpServer ? `leased from ${host.dhcpServer}` : 'enabled, no lease'}</dd>
              </>
            )}
            <dt className="text-muted">MAC</dt>
            <dd className="text-fg-bright">{host.mac}</dd>
          </dl>
        </section>
      )}
    </div>
  );
}
