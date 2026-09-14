import type { NetworkState } from '../engine';
import type { CloudObject } from '../engine/terraform/cloud';
import { stateSummary } from '../engine/terraform/grade';
import Icon, { NF } from './Icon';

interface Props {
  network: NetworkState;
  hostId: string;
}

function Badge({ managed }: { managed: boolean }) {
  return managed ? (
    <span className="pill border-accent/25 bg-accent-soft text-accent" title="Recorded in Terraform state">
      terraform
    </span>
  ) : (
    <span className="pill border-warning/30 bg-warning/[0.08] text-warning" title="Exists in the cloud, but no Terraform state tracks it">
      unmanaged
    </span>
  );
}

function Row({ o, managed, detail, indent = 0 }: { o: CloudObject; managed: boolean; detail: string; indent?: number }) {
  return (
    <li className="flex items-start justify-between gap-2 py-1" style={{ paddingLeft: `${indent * 14}px` }}>
      <span className="min-w-0">
        <span className="block truncate font-mono text-[12px] text-fg-bright">{String(o.attrs.name ?? o.id)}</span>
        <span className="block truncate font-mono text-[10.5px] text-muted">
          {o.id} · {detail}
        </span>
      </span>
      <Badge managed={managed} />
    </li>
  );
}

/**
 * The NetLab Cloud account next to a Terraform lab: what really exists, grouped the way a
 * console would group it, and whether Terraform state knows about each object. That last
 * part is the point, in the drift and import labs especially.
 */
export default function CloudPanel({ network, hostId }: Props) {
  const lx = network.hosts[hostId]?.linux;
  const acct = lx?.cloud;
  if (!lx || !acct) return null;
  const summary = stateSummary(lx);
  const all = Object.values(acct.objects);
  const of = (kind: CloudObject['kind']) => all.filter((o) => o.kind === kind);
  const managed = (o: CloudObject) => summary.managedIds.has(o.id);
  const networks = of('network');
  const subnets = of('subnet');
  const instances = of('instance');
  const orphanSubnets = subnets.filter((s) => !networks.some((n) => n.id === s.attrs.network_id));
  const instanceRows = (subnetId: string, indent: number) =>
    instances.filter((i) => i.attrs.subnet_id === subnetId).map((i) => <Row key={i.id} o={i} managed={managed(i)} detail={`${i.attrs.size} · ${i.attrs.private_ip ?? '-'} · ${i.attrs.status}`} indent={indent} />);
  const others = [...of('firewall'), ...of('bucket'), ...of('database')];
  const hcp = acct.hcp;

  return (
    <div className="space-y-4">
      <section className="card p-3">
        <h2 className="label flex items-center gap-1.5 text-muted">
          <Icon g={NF.cloud} className="text-accent" />
          NetLab Cloud
        </h2>
        <p className="mb-2 mt-0.5 text-[11px] text-muted">
          Account {acct.account}. What exists right now, and whether Terraform state tracks it. Updates as you work.
        </p>
        {all.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted">Nothing exists yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {networks.map((n) => (
              <li key={n.id} className="py-1">
                <ul>
                  <Row o={n} managed={managed(n)} detail={`${n.region} · ${n.attrs.cidr_block}`} />
                  {subnets
                    .filter((s) => s.attrs.network_id === n.id)
                    .map((s) => (
                      <li key={s.id}>
                        <ul>
                          <Row o={s} managed={managed(s)} detail={`${s.attrs.cidr_block} · ${s.attrs.zone}${s.attrs.public ? ' · public' : ''}`} indent={1} />
                          {instanceRows(s.id, 2)}
                        </ul>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
            {orphanSubnets.map((s) => (
              <li key={s.id}>
                <ul>
                  <Row o={s} managed={managed(s)} detail={String(s.attrs.cidr_block)} />
                  {instanceRows(s.id, 1)}
                </ul>
              </li>
            ))}
            {others.length > 0 && (
              <li className="py-1">
                <ul>
                  {others.map((o) => (
                    <Row
                      key={o.id}
                      o={o}
                      managed={managed(o)}
                      detail={o.kind === 'firewall' ? `firewall · ${((o.attrs.ingress as unknown[] | null) ?? []).length} rules` : o.kind === 'bucket' ? `bucket · ${o.region}${o.attrs.versioning ? ' · versioned' : ''}` : `${o.attrs.engine} ${o.attrs.engine_version} · ${o.attrs.size}`}
                    />
                  ))}
                </ul>
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="card p-3">
        <h2 className="label flex items-center gap-1.5 text-muted">
          <Icon g={NF.hdd} className="text-accent" />
          Terraform state
        </h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-muted">Backend</dt>
          <dd className="font-mono text-fg">{summary.backend === 'cloud' ? 'HCP Terraform' : summary.backend}</dd>
          <dt className="text-muted">Workspace</dt>
          <dd className="font-mono text-fg">{summary.workspace}</dd>
          <dt className="text-muted">Resources</dt>
          <dd className="font-mono text-fg">{summary.instances}</dd>
        </dl>
      </section>

      {hcp && (
        <section className="card p-3">
          <h2 className="label flex items-center gap-1.5 text-muted">
            <Icon g={NF.cloudUp} className="text-accent" />
            HCP Terraform · {hcp.organization}
          </h2>
          <ul className="mt-2 divide-y divide-border/60">
            {Object.values(hcp.workspaces).map((w) => (
              <li key={w.name} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[12px] text-fg-bright">{w.name}</span>
                  <span className="block truncate text-[10.5px] text-muted">
                    {w.project}
                    {w.tags.length ? ` · ${w.tags.join(', ')}` : ''}
                  </span>
                </span>
                <span className="font-mono text-[11px] text-muted">{w.state ? `${(JSON.parse(w.state).resources ?? []).length} res` : 'empty'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
