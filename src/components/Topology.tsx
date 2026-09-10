import { compareInterfaceNames, interfaceStatus, isSvi, shortInterfaceName, type DeviceState } from '../engine';

function Host({ x, y, name, ip, kind }: { x: number; y: number; name: string; ip?: string; kind: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-46} y={-26} width={92} height={52} rx={8} className="fill-surface-2 stroke-border" />
      <text y={-8} textAnchor="middle" className="fill-fg-bright text-[11px] font-semibold">
        {name}
      </text>
      <text y={6} textAnchor="middle" className="fill-muted text-[9px]">
        {kind}
      </text>
      <text y={19} textAnchor="middle" className="fill-fg text-[9px] font-mono">
        {ip ?? ''}
      </text>
    </g>
  );
}

export default function Topology({ state }: { state: DeviceState }) {
  const hosts = state.neighbors;
  const width = Math.max(360, hosts.length * 110 + 40);
  const height = 220;
  const switchX = width / 2;
  const switchY = 160;

  const physical = Object.values(state.interfaces)
    .filter((i) => !isSvi(i.name))
    .sort((a, b) => compareInterfaceNames(a.name, b.name));
  const svis = Object.values(state.interfaces).filter((i) => isSvi(i.name));

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-surface p-3">
        <h2 className="mb-1 text-sm font-semibold text-fg-bright">Topology</h2>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Network topology">
          {hosts.map((h, i) => {
            const x = hosts.length === 1 ? switchX : 60 + (i * (width - 120)) / (hosts.length - 1);
            const iface = state.interfaces[h.interface];
            const up = iface && !iface.shutdown;
            return (
              <g key={h.name}>
                <line x1={x} y1={56} x2={switchX} y2={switchY - 22} className={up ? 'stroke-success' : 'stroke-danger'} strokeWidth={1.5} strokeDasharray={up ? undefined : '4 3'} />
                <text x={(x + switchX) / 2} y={(56 + switchY - 22) / 2} textAnchor="middle" className="fill-muted text-[8px] font-mono">
                  {shortInterfaceName(h.interface)}
                </text>
                <Host x={x} y={30} name={h.name} ip={h.ip} kind={h.kind.toUpperCase()} />
              </g>
            );
          })}
          <g transform={`translate(${switchX} ${switchY})`}>
            <rect x={-60} y={-22} width={120} height={44} rx={8} className="fill-accent-soft stroke-accent" />
            <text y={-3} textAnchor="middle" className="fill-fg-bright text-[11px] font-semibold">
              {state.hostname}
            </text>
            <text y={11} textAnchor="middle" className="fill-muted text-[9px]">
              SWITCH
            </text>
          </g>
        </svg>
      </section>

      <section className="rounded-xl border border-border bg-surface p-3">
        <h2 className="mb-2 text-sm font-semibold text-fg-bright">Interface status</h2>
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
            {physical.map((i) => {
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
            {svis.map((i) => (
              <tr key={i.name} className="border-t border-border/60">
                <td className="py-1 text-fg-bright">{i.name}</td>
                <td className="py-1">svi</td>
                <td className="py-1">{i.ipAddress ?? '—'}</td>
                <td className={`py-1 ${i.shutdown ? 'text-danger' : 'text-success'}`}>● {i.shutdown ? 'disabled' : 'up'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
