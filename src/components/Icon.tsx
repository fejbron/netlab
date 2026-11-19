/**
 * Nerd Font glyphs (Font Awesome range, stable across Nerd Fonts v3).
 * Rendered with the self-hosted JetBrainsMono Nerd Font; see index.css.
 */
export const NF = {
  terminal: '',
  server: '',
  sitemap: '',
  exchange: '',
  desktop: '',
  lock: '',
  unlock: '',
  check: '',
  times: '',
  circle: '',
  circleO: '',
  star: '',
  starO: '',
  trophy: '',
  user: '',
  signIn: '',
  signOut: '',
  refresh: '',
  play: '',
  bulb: '',
  flag: '',
  arrowRight: '',
  arrowLeft: '',
  bolt: '',
  github: '',
  envelope: '',
  cloud: '',
  cloudUp: '',
  book: '',
  gradCap: '',
  plug: '',
  eye: '',
  clock: '',
  list: '',
  save: '',
  warning: '',
  info: '',
  chevronRight: '',
  hdd: '',
  wifi: '',
  code: '',
  gear: '',
  branch: '',
  cubes: '',
  database: '',
  users: '',
  globe: '',
  random: '',
  inbox: '',
  cogs: '',
  shield: '',
  archive: '',
  stickyNote: '',
  chevronLeft: '',
  question: '',
  tasks: '',
  sliders: '',
  key: '',
  compass: '',
  barChart: '',
  tachometer: '',
  rocket: '',
  cube: '',
  laptop: '',
  mobile: '',
  share: '',
  heartbeat: '',
  filter: '',
  tag: '',
  server2: '',
  sitemapAlt: '',
} as const;

export type Glyph = (typeof NF)[keyof typeof NF];

export default function Icon({ g, className = '', label }: { g: Glyph | string; className?: string; label?: string }) {
  return (
    <span className={`nf ${className}`} aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined}>
      {g}
    </span>
  );
}

/** Device kind → glyph. */
export function deviceGlyph(kind: 'router' | 'switch' | 'pc' | 'host' | string): Glyph {
  if (kind === 'router') return NF.exchange;
  if (kind === 'switch') return NF.sitemap;
  return NF.desktop;
}
