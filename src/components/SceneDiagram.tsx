import type { NodeKind, Scene, SceneLink, SceneNode } from '../content/lesson';
import { usePrefersReducedMotion } from '../lib/motion';
import { NF } from './Icon';

/*
 * Draws a lesson scene: nodes on a grid, links between them, and traffic running along
 * the links. The theme is monochrome, so state is carried by stroke weight, dashes,
 * opacity and tags rather than by colour.
 */

const CELL_Y = 84;
const PAD_X = 84;
const PAD_Y = 44;
const NODE_W = 120;
const NODE_H = 54;
const MAX_W = 182;

const GLYPH: Record<NodeKind, string> = {
  users: NF.users,
  client: NF.laptop,
  server: NF.server,
  lb: NF.random,
  db: NF.database,
  replica: NF.database,
  cache: NF.bolt,
  queue: NF.inbox,
  cdn: NF.globe,
  dns: NF.compass,
  service: NF.cube,
  storage: NF.archive,
  worker: NF.cogs,
  proxy: NF.filter,
  cloud: NF.cloud,
  region: '',
  note: NF.stickyNote,
};

const KIND_LABEL: Partial<Record<NodeKind, string>> = {
  lb: 'load balancer',
  db: 'database',
  replica: 'replica',
  cache: 'cache',
  queue: 'queue',
  cdn: 'CDN',
  dns: 'DNS',
  storage: 'object storage',
  worker: 'worker',
  proxy: 'proxy',
  cloud: 'cloud',
};

/** Grid-to-pixel mapping for one scene. Columns widen when nodes sit in adjacent columns. */
interface Layout {
  cellX: number;
}

const px = (x: number, l: Layout) => PAD_X + x * l.cellX;
const py = (y: number) => PAD_Y + y * CELL_Y;

function subOf(n: SceneNode): string | undefined {
  return n.sub ?? KIND_LABEL[n.kind];
}

/** Box width for a node: wide enough for its label and sub-label, within limits. */
function nodeWidth(n: SceneNode): number {
  if (n.kind === 'region') return NODE_W;
  const textStart = n.kind === 'users' || n.kind === 'note' ? 16 : 40;
  const need = textStart + Math.max(n.label.length * 6.7, (subOf(n) ?? '').length * 5.3) + 12;
  return Math.min(MAX_W, Math.max(NODE_W, Math.round(need)));
}

/** Where a line from the node's centre towards (tx, ty) leaves the node's box. */
function edgePoint(n: SceneNode, tx: number, ty: number, l: Layout): [number, number] {
  const cx = px(n.x, l);
  const cy = py(n.y);
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = nodeWidth(n) / 2 + 6;
  const hh = NODE_H / 2 + 6;
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return [cx + dx * t, cy + dy * t];
}

function Region({ n, l, widest }: { n: SceneNode; l: Layout; widest: number }) {
  const span = n.span ?? { w: 1, h: 1 };
  const left = px(n.x, l) - widest / 2 - 14;
  const top = py(n.y) - NODE_H / 2 - 24;
  const width = (span.w - 1) * l.cellX + widest + 28;
  const height = (span.h - 1) * CELL_Y + NODE_H + 38;
  const dim = n.state === 'dim' || n.state === 'down';
  return (
    <g opacity={dim ? 0.45 : 1}>
      <rect x={left} y={top} width={width} height={height} rx={16} fill="var(--color-surface)" stroke="var(--color-border-strong)" strokeDasharray={n.state === 'down' ? '6 4' : '3 5'} />
      <text x={left + 12} y={top + 15} className="font-mono" fontSize="9" letterSpacing="0.08em" fill="var(--color-muted)">
        {n.label.toUpperCase()}
        {n.state === 'down' ? ' · DOWN' : ''}
      </text>
      {n.tag && (
        <text x={left + width - 12} y={top + 15} textAnchor="end" className="font-mono" fontSize="9" fill="var(--color-fg)">
          {n.tag}
        </text>
      )}
    </g>
  );
}

function Node({ n, l }: { n: SceneNode; l: Layout }) {
  const cx = px(n.x, l);
  const cy = py(n.y);
  const w = nodeWidth(n);
  const state = n.state ?? 'ok';
  const opacity = state === 'dim' ? 0.4 : state === 'down' ? 0.75 : 1;
  const stroke = state === 'hot' || state === 'new' ? 'var(--color-fg-bright)' : state === 'warn' ? 'var(--color-fg)' : 'var(--color-border-strong)';
  const dash = state === 'down' ? '5 4' : state === 'warn' ? '2 3' : undefined;
  const tag = n.tag ?? (state === 'down' ? 'DOWN' : undefined);
  const sub = subOf(n);

  if (n.kind === 'users') {
    return (
      <g transform={`translate(${cx} ${cy})`} opacity={opacity}>
        <text y={-4} textAnchor="middle" className="font-mono" fontSize="22" fill={state === 'hot' ? 'var(--color-fg-bright)' : 'var(--color-fg)'} letterSpacing="6">
          {`${NF.user}${NF.user}${NF.user}`}
        </text>
        <text y={14} textAnchor="middle" className="font-mono" fontSize="11" fontWeight="700" fill="var(--color-fg-bright)">
          {n.label}
        </text>
        {sub && (
          <text y={27} textAnchor="middle" className="font-mono" fontSize="9" fill="var(--color-muted)">
            {sub}
          </text>
        )}
        {tag && <Tag text={tag} y={-NODE_H / 2 - 6} />}
      </g>
    );
  }

  if (n.kind === 'note') {
    return (
      <g transform={`translate(${cx} ${cy})`} opacity={opacity}>
        <rect x={-w / 2} y={-NODE_H / 2} width={w} height={NODE_H} rx={8} fill="var(--color-surface)" stroke={state === 'hot' ? 'var(--color-fg)' : 'var(--color-border)'} strokeDasharray="3 3" />
        <text y={n.sub ? -3 : 4} textAnchor="middle" className="font-mono" fontSize="10" fill={state === 'hot' ? 'var(--color-fg-bright)' : 'var(--color-fg)'}>
          {n.label}
        </text>
        {n.sub && (
          <text y={12} textAnchor="middle" className="font-mono" fontSize="9" fill="var(--color-muted)">
            {n.sub}
          </text>
        )}
        {tag && <Tag text={tag} y={-NODE_H / 2 - 6} />}
      </g>
    );
  }

  return (
    <g transform={`translate(${cx} ${cy})`} opacity={opacity}>
      {state === 'new' && <rect x={-w / 2 - 5} y={-NODE_H / 2 - 5} width={w + 10} height={NODE_H + 10} rx={14} fill="none" stroke="var(--color-fg-bright)" strokeOpacity={0.25} />}
      {state === 'hot' && <rect x={-w / 2 - 4} y={-NODE_H / 2 - 4} width={w + 8} height={NODE_H + 8} rx={13} fill="var(--color-fg-bright)" fillOpacity={0.08} />}
      <rect x={-w / 2} y={-NODE_H / 2} width={w} height={NODE_H} rx={10} fill="var(--color-surface-2)" stroke={stroke} strokeWidth={state === 'hot' ? 2 : 1.2} strokeDasharray={dash} />
      <text x={-w / 2 + 12} y={5} className="font-mono" fontSize="16" fill={state === 'down' ? 'var(--color-muted)' : 'var(--color-fg-bright)'}>
        {state === 'down' ? NF.times : GLYPH[n.kind]}
      </text>
      <text x={-w / 2 + 36} y={sub ? -2 : 4} className="font-mono" fontSize="11" fontWeight="700" fill="var(--color-fg-bright)">
        {n.label}
      </text>
      {sub && (
        <text x={-w / 2 + 36} y={12} className="font-mono" fontSize="9" fill="var(--color-muted)">
          {sub}
        </text>
      )}
      {tag && <Tag text={tag} y={-NODE_H / 2 - 6} />}
    </g>
  );
}

function Tag({ text, y }: { text: string; y: number }) {
  const w = text.length * 6.2 + 14;
  return (
    <g transform={`translate(0 ${y})`}>
      <rect x={-w / 2} y={-9} width={w} height={16} rx={8} fill="var(--color-surface-3)" stroke="var(--color-border-strong)" />
      <text y={3} textAnchor="middle" className="font-mono" fontSize="9" letterSpacing="0.04em" fill="var(--color-fg-bright)">
        {text}
      </text>
    </g>
  );
}

const DOTS = { light: 1, normal: 2, heavy: 4 } as const;
const SPEED = { light: 2.6, normal: 2.2, heavy: 1.6 } as const;

function Link({ l, a, b, animate, layout }: { l: SceneLink; a: SceneNode; b: SceneNode; animate: boolean; layout: Layout }) {
  const [x1, y1] = edgePoint(a, px(b.x, layout), py(b.y), layout);
  const [x2, y2] = edgePoint(b, px(a.x, layout), py(a.y), layout);
  const state = l.state ?? 'ok';
  const stroke = state === 'off' ? 'var(--color-border)' : state === 'fail' ? 'var(--color-fg)' : 'var(--color-border-strong)';
  const dash = state === 'off' ? '2 5' : state === 'fail' ? '7 5' : state === 'dashed' ? '6 4' : undefined;
  const flow = l.flow ?? 'to';
  const rate = l.rate ?? 'normal';
  const forward = `M ${x1} ${y1} L ${x2} ${y2}`;
  const back = `M ${x2} ${y2} L ${x1} ${y1}`;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  // Labels sit just off the line, on the side away from the horizontal so they do not cover traffic.
  const steep = Math.abs(y2 - y1) > Math.abs(x2 - x1);
  const dots = (path: string, muted: boolean) =>
    Array.from({ length: DOTS[rate] }, (_, i) => (
      <circle
        key={`${path}-${i}`}
        r={3.2}
        fill={muted ? 'var(--color-muted)' : 'var(--color-fg-bright)'}
        className={state === 'fail' ? 'flow flow-fail' : 'flow'}
        style={{ offsetPath: `path('${path}')`, animationDuration: `${SPEED[rate]}s`, animationDelay: `${(-i * SPEED[rate]) / DOTS[rate]}s` }}
      />
    ));
  const lw = l.label ? l.label.length * 5.6 + 12 : 0;
  const lx = steep ? mx + 10 + lw / 2 : mx;
  const ly = steep ? my : my - 11;
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={state === 'fail' ? 1.6 : 1.4} strokeDasharray={dash} opacity={state === 'off' ? 0.7 : 1} />
      {animate && state !== 'off' && flow !== 'none' && (
        <>
          {(flow === 'to' || flow === 'both') && dots(forward, false)}
          {(flow === 'from' || flow === 'both') && dots(back, flow === 'both')}
        </>
      )}
      {state === 'fail' && (
        <text x={mx} y={my + 4} textAnchor="middle" className="font-mono" fontSize="12" fill="var(--color-fg-bright)">
          {NF.times}
        </text>
      )}
      {l.label && (
        <g>
          <rect x={lx - lw / 2} y={ly - 7} width={lw} height={14} rx={7} fill="var(--color-bg)" stroke="var(--color-border)" />
          <text x={lx} y={ly + 3} textAnchor="middle" className="font-mono" fontSize="9" fill="var(--color-fg)">
            {l.label}
          </text>
        </g>
      )}
    </g>
  );
}

export default function SceneDiagram({ scene, title }: { scene: Scene; title: string }) {
  const reduced = usePrefersReducedMotion();
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const regions = scene.nodes.filter((n) => n.kind === 'region');
  const nodes = scene.nodes.filter((n) => n.kind !== 'region');
  const widest = Math.max(NODE_W, ...nodes.map(nodeWidth));
  // Nodes in neighbouring columns of the same row need the columns to be at least a node apart.
  const adjacent = nodes.some((a) => nodes.some((b) => a !== b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) < 0.75));
  const layout: Layout = { cellX: adjacent ? widest + 16 : 76 };
  const maxX = Math.max(4, ...scene.nodes.map((n) => n.x + (n.span ? n.span.w - 1 : 0)));
  const maxY = Math.max(1, ...scene.nodes.map((n) => n.y + (n.span ? n.span.h - 1 : 0)));
  const width = px(maxX, layout) + PAD_X + (widest - NODE_W) / 2;
  const height = py(maxY) + PAD_Y + 10;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={title} style={{ maxHeight: 520 }}>
      <defs>
        <pattern id="scene-dots" width="19" height="19" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="var(--color-border)" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="url(#scene-dots)" />
      {regions.map((n) => (
        <Region key={n.id} n={n} l={layout} widest={widest} />
      ))}
      {scene.links.map((l, i) => {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        return a && b ? <Link key={`${l.from}-${l.to}-${i}`} l={l} a={a} b={b} animate={!reduced} layout={layout} /> : null;
      })}
      {nodes.map((n) => (
        <Node key={n.id} n={n} l={layout} />
      ))}
    </svg>
  );
}
