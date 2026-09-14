/**
 * Text Terraform prints: execution plans with their diff symbols, drift notes, output
 * values, and `terraform show` / `state show` renderings of objects in state.
 */
import type { Change, Drift, OutputChange, Run } from './run';
import { PROVIDERS, providerFor, type ResourceDef } from './providers';
import { TF_VERSION, type Inst } from './state';
import { equal, isObj, isUnknown, renderString, renderValue, type Val, type ValObject } from './values';

export const RULE = '─'.repeat(77);

type Sym = '+' | '-' | '~' | ' ';

interface Ctx {
  sensitive: Set<string>;
  writeOnly: Set<string>;
  forceNew: Set<string>;
  blocks: Set<string>;
  maps: Set<string>;
}

function schemaOf(run: Run | undefined, source: string, type: string): ResourceDef | undefined {
  const def = PROVIDERS[source] ?? providerFor(source);
  if (!def) return undefined;
  const version = def.builtin ? TF_VERSION : run?.lock[source]?.version ?? def.versions[def.versions.length - 1];
  return def.resources(version)[type] ?? (def.data(version)[type] as unknown as ResourceDef | undefined);
}

function ctxFor(run: Run | undefined, source: string, type: string, sensitive: string[], writeOnly: string[], forceNew: string[]): Ctx {
  const s = schemaOf(run, source.replace(/^provider\["(registry\.terraform\.io\/)?/, '').replace(/"\].*$/, ''), type);
  return {
    sensitive: new Set([...sensitive, ...Object.entries(s?.attrs ?? {}).filter(([, d]) => d.sensitive).map(([k]) => k)]),
    writeOnly: new Set([...writeOnly, ...Object.entries(s?.attrs ?? {}).filter(([, d]) => d.writeOnly).map(([k]) => k)]),
    forceNew: new Set(forceNew),
    blocks: new Set(Object.keys(s?.blocks ?? {})),
    maps: new Set(Object.entries(s?.attrs ?? {}).filter(([, d]) => d.type.t === 'map').map(([k]) => k)),
  };
}

function prim(v: Val): string {
  if (isUnknown(v)) return '(known after apply)';
  if (v === null) return 'null';
  if (typeof v === 'string') {
    if (v.includes('\n')) return '<<-EOT';
    return renderString(v);
  }
  return String(v);
}

function isCollection(v: Val | undefined): v is Val[] | ValObject {
  return Array.isArray(v) || isObj(v ?? null);
}

const pad = (n: number) => ' '.repeat(n);
const symText = (s: Sym) => `  ${s}`;

/** Lines for a heredoc-style multi-line string value. */
function multiline(v: string, indent: number): string[] {
  const body = v.replace(/\n$/, '').split('\n');
  return [...body.map((l) => pad(indent + 4) + l), pad(indent + 2) + 'EOT'];
}

/** Render one collection value (create or delete) with every element marked. */
function collectionLines(v: Val[] | ValObject, sym: Sym, indent: number, quoteKeys: boolean): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (isCollection(item)) {
        const inner = collectionLines(item, sym, indent + 4, true);
        out.push(`${pad(indent)}${symText(sym)} ${Array.isArray(item) ? '[' : '{'}`, ...inner, `${pad(indent + 4)}${Array.isArray(item) ? ']' : '}'},`);
      } else out.push(`${pad(indent)}${symText(sym)} ${prim(item)}${sym === '-' ? '' : ''},`);
    }
    return out;
  }
  const keys = Object.keys(v);
  const names = keys.map((k) => (quoteKeys ? JSON.stringify(k) : k));
  const width = Math.max(0, ...names.map((n) => n.length));
  keys.forEach((k, i) => {
    const item = v[k];
    const name = names[i].padEnd(width);
    if (isCollection(item) && (Array.isArray(item) ? item.length : Object.keys(item).length)) {
      out.push(`${pad(indent)}${symText(sym)} ${name} = ${Array.isArray(item) ? '[' : '{'}`, ...collectionLines(item, sym, indent + 4, true), `${pad(indent + 4)}${Array.isArray(item) ? ']' : '}'}`);
    } else {
      const text = isCollection(item) ? (Array.isArray(item) ? '[]' : '{}') : prim(item);
      out.push(`${pad(indent)}${symText(sym)} ${name} = ${text}${sym === '-' ? ' -> null' : ''}`);
    }
  });
  return out;
}

/** Diff of two collection values for an update. */
function collectionDiff(a: Val[] | ValObject, b: Val[] | ValObject, indent: number, quoteKeys: boolean): string[] {
  const out: string[] = [];
  if (Array.isArray(a) && Array.isArray(b)) {
    let hidden = 0;
    const used = new Set<number>();
    for (const item of b) {
      const j = a.findIndex((x, idx) => !used.has(idx) && equal(x, item));
      if (j >= 0 && !isUnknown(item)) {
        used.add(j);
        hidden++;
      } else out.push(`${pad(indent)}${symText('+')} ${prim(item)},`);
    }
    a.forEach((x, idx) => {
      if (!used.has(idx)) out.push(`${pad(indent)}${symText('-')} ${prim(x)},`);
    });
    if (hidden) out.push(`${pad(indent + 4)}# (${hidden} unchanged element${hidden === 1 ? '' : 's'} hidden)`);
    return out;
  }
  if (isObj(a as Val) && isObj(b as Val)) {
    const ao = a as ValObject;
    const bo = b as ValObject;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
    const shown = keys.filter((k) => !equal(ao[k] ?? null, bo[k] ?? null) || isUnknown(bo[k] ?? null) || !(k in ao) || !(k in bo));
    const names = shown.map((k) => (quoteKeys ? JSON.stringify(k) : k));
    const width = Math.max(0, ...names.map((n) => n.length));
    shown.forEach((k, i) => {
      const name = names[i].padEnd(width);
      if (!(k in ao)) out.push(`${pad(indent)}${symText('+')} ${name} = ${prim(bo[k])}`);
      else if (!(k in bo)) out.push(`${pad(indent)}${symText('-')} ${name} = ${prim(ao[k])} -> null`);
      else out.push(`${pad(indent)}${symText('~')} ${name} = ${prim(ao[k])} -> ${prim(bo[k])}`);
    });
    const hidden = keys.length - shown.length;
    if (hidden) out.push(`${pad(indent + 4)}# (${hidden} unchanged element${hidden === 1 ? '' : 's'} hidden)`);
    return out;
  }
  return out;
}

const IDENTIFYING = ['id', 'name', 'tags'];

/** The body of a resource in a plan: attributes then nested blocks, then the hidden count. */
function objectDiff(before: ValObject | null, after: ValObject | null, action: 'create' | 'delete' | 'update' | 'replace' | 'read' | 'noop', c: Ctx, indent: number): string[] {
  const out: string[] = [];
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => !c.blocks.has(k)).sort();
  type Row = { name: string; lines: (width: number) => string[] };
  const rows: Row[] = [];
  let hidden = 0;
  const valueText = (k: string, v: Val) => (c.writeOnly.has(k) ? '(write-only attribute)' : c.sensitive.has(k) && !isUnknown(v) && v !== null ? '(sensitive value)' : null);
  for (const k of keys) {
    const a = before?.[k] ?? null;
    const b = after?.[k] ?? null;
    const force = c.forceNew.has(k) ? ' # forces replacement' : '';
    const quote = c.maps.has(k) || true;
    if (action === 'create' || action === 'read') {
      if (b === null && !c.writeOnly.has(k)) continue;
      if (c.writeOnly.has(k) && b === null) continue;
      const special = valueText(k, b);
      if (special) rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('+')} ${k.padEnd(w)} = ${special}`] });
      else if (isCollection(b) && (Array.isArray(b) ? b.length : Object.keys(b).length)) {
        rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('+')} ${k.padEnd(w)} = ${Array.isArray(b) ? '[' : '{'}`, ...collectionLines(b, '+', indent + 4, quote), `${pad(indent + 4)}${Array.isArray(b) ? ']' : '}'}`] });
      } else if (typeof b === 'string' && b.includes('\n')) {
        rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('+')} ${k.padEnd(w)} = <<-EOT`, ...multiline(b, indent + 4)] });
      } else rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('+')} ${k.padEnd(w)} = ${isCollection(b) ? (Array.isArray(b) ? '[]' : '{}') : prim(b)}`] });
      continue;
    }
    if (action === 'delete') {
      if (a === null) continue;
      const special = valueText(k, a);
      if (special) rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('-')} ${k.padEnd(w)} = ${special} -> null`] });
      else if (isCollection(a) && (Array.isArray(a) ? a.length : Object.keys(a).length)) {
        rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('-')} ${k.padEnd(w)} = ${Array.isArray(a) ? '[' : '{'}`, ...collectionLines(a, '-', indent + 4, quote), `${pad(indent + 4)}${Array.isArray(a) ? ']' : '}'} -> null`] });
      } else rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('-')} ${k.padEnd(w)} = ${isCollection(a) ? (Array.isArray(a) ? '[]' : '{}') : prim(a)} -> null`] });
      continue;
    }
    // update, replace, noop
    const same = equal(a, b) && !isUnknown(b);
    if (same) {
      if (IDENTIFYING.includes(k) && a !== null && !isCollection(a)) {
        const special = valueText(k, a);
        rows.push({ name: k, lines: (w) => [`${pad(indent)}    ${k.padEnd(w)} = ${special ?? prim(a)}`] });
      } else if (a !== null || c.writeOnly.has(k)) hidden++;
      continue;
    }
    if (c.writeOnly.has(k)) continue;
    const special = valueText(k, b) ?? valueText(k, a);
    if (a === null) {
      if (special) rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('+')} ${k.padEnd(w)} = ${special}${force}`] });
      else if (isCollection(b) && (Array.isArray(b) ? b.length : Object.keys(b).length)) rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('+')} ${k.padEnd(w)} = ${Array.isArray(b) ? '[' : '{'}${force}`, ...collectionLines(b, '+', indent + 4, quote), `${pad(indent + 4)}${Array.isArray(b) ? ']' : '}'}`] });
      else rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('+')} ${k.padEnd(w)} = ${isCollection(b) ? (Array.isArray(b) ? '[]' : '{}') : prim(b)}${force}`] });
    } else if (b === null) {
      rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('-')} ${k.padEnd(w)} = ${special ?? (isCollection(a) ? (Array.isArray(a) ? '[]' : '{}') : prim(a))} -> null${force}`] });
    } else if (special) {
      rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('~')} ${k.padEnd(w)} = (sensitive value)${force}`] });
    } else if (isCollection(a) && isCollection(b)) {
      rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('~')} ${k.padEnd(w)} = ${Array.isArray(b) ? '[' : '{'}${force}`, ...collectionDiff(a, b, indent + 4, quote), `${pad(indent + 4)}${Array.isArray(b) ? ']' : '}'}`] });
    } else {
      rows.push({ name: k, lines: (w) => [`${pad(indent)}${symText('~')} ${k.padEnd(w)} = ${isCollection(a) ? '[...]' : prim(a)} -> ${isCollection(b) ? '[...]' : prim(b)}${force}`] });
    }
  }
  const width = Math.max(0, ...rows.map((r) => r.name.length));
  for (const r of rows) out.push(...r.lines(width));
  // nested blocks
  let hiddenBlocks = 0;
  for (const bname of [...c.blocks].sort()) {
    const a = ((before?.[bname] as ValObject[] | null) ?? []) as ValObject[];
    const b = isUnknown(after?.[bname] ?? null) ? null : (((after?.[bname] as ValObject[] | null) ?? []) as ValObject[]);
    const inner = (x: ValObject | null, y: ValObject | null, act: 'create' | 'delete' | 'update') => objectDiff(x, y, act, { sensitive: new Set(), writeOnly: new Set(), forceNew: new Set(), blocks: new Set(), maps: new Set() }, indent + 4);
    if (action === 'create' || action === 'read') {
      for (const item of b ?? []) out.push(`${pad(indent)}${symText('+')} ${bname} {`, ...inner(null, item, 'create'), `${pad(indent + 4)}}`);
      continue;
    }
    if (action === 'delete') {
      for (const item of a) out.push(`${pad(indent)}${symText('-')} ${bname} {`, ...inner(item, null, 'delete'), `${pad(indent + 4)}}`);
      continue;
    }
    const bb = b ?? [];
    const used = new Set<number>();
    for (const item of bb) {
      const j = a.findIndex((x, i) => !used.has(i) && equal(x, item));
      if (j >= 0) {
        used.add(j);
        hiddenBlocks++;
      } else out.push(`${pad(indent)}${symText('+')} ${bname} {`, ...inner(null, item, 'create'), `${pad(indent + 4)}}`);
    }
    a.forEach((x, i) => {
      if (!used.has(i)) out.push(`${pad(indent)}${symText('-')} ${bname} {`, ...inner(x, null, 'delete'), `${pad(indent + 4)}}`);
    });
  }
  if (hidden) out.push(`${pad(indent + 4)}# (${hidden} unchanged attribute${hidden === 1 ? '' : 's'} hidden)`);
  if (hiddenBlocks) out.push(`${pad(indent + 4)}# (${hiddenBlocks} unchanged block${hiddenBlocks === 1 ? '' : 's'} hidden)`);
  return out;
}

function header(c: Change): string {
  const kw = c.mode === 'data' ? 'data' : 'resource';
  return `${kw} "${c.type}" "${c.name}"`;
}

function changeLines(run: Run, c: Change): string[] {
  const ctx = ctxFor(run, c.providerSource, c.type, c.sensitive, c.writeOnly, c.forceNew);
  const moved = run.moved.find((m) => m.to === c.addr);
  const out: string[] = [];
  const reasonLine = (): string[] => {
    switch (c.reason) {
      case 'not-in-config':
        return [`  # (because ${c.module ? c.module + '.' : ''}${c.type}.${c.name} is not in configuration)`];
      case 'module-gone':
        return [`  # (because ${c.module} is not in configuration)`];
      case 'count-index':
        return [`  # (because index ${String(c.key !== undefined ? `[${c.key}]` : '')} is out of range for count)`];
      case 'each-key':
        return [`  # (because key [${JSON.stringify(c.key)}] is not in for_each map)`];
      case 'removed':
        return c.action === 'forget' ? [] : [`  # (because ${c.module ? c.module + '.' : ''}${c.type}.${c.name} is not in configuration)`];
      default:
        return [];
    }
  };
  switch (c.action) {
    case 'create':
      out.push(`  # ${c.addr} will be created`, `  + ${header(c)} {`, ...objectDiff(null, c.after, 'create', ctx, 4), '    }');
      break;
    case 'read':
      out.push(`  # ${c.addr} will be read during apply`, '  # (config refers to values not yet known)', ` <= ${header(c)} {`, ...objectDiff(null, c.after, 'read', ctx, 4), '    }');
      break;
    case 'delete':
      out.push(`  # ${c.addr} will be destroyed`, ...reasonLine(), `  - ${header(c)} {`, ...objectDiff(c.before, null, 'delete', ctx, 4), '    }');
      break;
    case 'forget':
      out.push(`  # ${c.addr} will no longer be managed by Terraform`, `. ${header(c)} {`, ...objectDiff(c.before, c.before, 'noop', ctx, 4), '    }');
      break;
    case 'update':
      if (c.importId !== undefined) out.push(`  # ${c.addr} will be updated in-place`, `  # (imported from "${c.importId}")`);
      else out.push(`  # ${c.addr} will be updated in-place`);
      if (moved) out.push(`  # (moved from ${moved.from})`);
      out.push(`  ~ ${header(c)} {`, ...objectDiff(c.before, c.after, 'update', ctx, 4), '    }');
      break;
    case 'replace': {
      const note = c.reason === 'tainted' ? `is tainted, so must be replaced` : c.reason === 'requested' ? 'will be replaced, as requested' : c.reason === 'triggered' ? 'will be replaced due to changes in replace_triggered_by' : 'must be replaced';
      out.push(`  # ${c.addr} ${note}`);
      if (moved) out.push(`  # (moved from ${moved.from})`);
      out.push(`${c.cbd ? '+/-' : '-/+'} ${header(c)} {`, ...objectDiff(c.before, c.after, 'replace', ctx, 4), '    }');
      break;
    }
    case 'noop':
      if (c.importId !== undefined) {
        out.push(`  # ${c.addr} will be imported`, `    ${header(c)} {`, ...objectDiff(c.before, c.after, 'noop', ctx, 4), '    }');
      } else if (moved) {
        out.push(`  # ${moved.from} has moved to ${c.addr}`, `    ${header(c)} {`, ...objectDiff(c.before, c.after, 'noop', ctx, 4), '    }');
      }
      break;
  }
  return out;
}

function driftLines(run: Run, d: Drift): string[] {
  const inst = run.priorInsts.get(d.addr);
  const ctx = ctxFor(run, inst?.provider ?? '', d.type, d.sensitive, [], []);
  const kw = `resource "${d.type}" "${d.name}"`;
  if (!d.after) return [`  # ${d.addr} has been deleted`, `  - ${kw} {`, ...deletedDrift(d.before, ctx), '    }'];
  return [`  # ${d.addr} has changed`, `  ~ ${kw} {`, ...objectDiff(d.before, d.after, 'update', ctx, 4), '    }'];
}

function deletedDrift(before: ValObject, ctx: Ctx): string[] {
  const shown = Object.keys(before).filter((k) => !ctx.blocks.has(k) && before[k] !== null);
  const idx = shown.indexOf('id');
  const out: string[] = [];
  const width = Math.max(...shown.filter((k) => IDENTIFYING.includes(k) && !isCollection(before[k])).map((k) => k.length), 2);
  if (idx >= 0) out.push(`      - ${'id'.padEnd(width)} = ${prim(before.id)} -> null`);
  if (before.name !== undefined && before.name !== null) out.push(`        ${'name'.padEnd(width)} = ${prim(before.name)}`);
  const hidden = shown.filter((k) => k !== 'id' && k !== 'name').length;
  if (hidden) out.push(`        # (${hidden} unchanged attribute${hidden === 1 ? '' : 's'} hidden)`);
  return out;
}

function outputLines(outputs: OutputChange[], indent = 2): string[] {
  const changed = outputs.filter((o) => (o.before === undefined) !== (o.after === undefined) || !equal(o.before ?? null, o.after ?? null) || isUnknown(o.after ?? null));
  const width = Math.max(0, ...changed.map((o) => o.name.length));
  const out: string[] = [];
  for (const o of changed) {
    const name = o.name.padEnd(width);
    if (o.before === undefined) {
      if (o.sensitive) out.push(`${pad(indent)}+ ${name} = (sensitive value)`);
      else if (isCollection(o.after) && (Array.isArray(o.after) ? o.after.length : Object.keys(o.after).length)) out.push(`${pad(indent)}+ ${name} = ${Array.isArray(o.after) ? '[' : '{'}`, ...collectionLines(o.after, '+', indent + 2, false), `${pad(indent + 2)}${Array.isArray(o.after) ? ']' : '}'}`);
      else out.push(`${pad(indent)}+ ${name} = ${isCollection(o.after) ? (Array.isArray(o.after) ? '[]' : '{}') : prim(o.after ?? null)}`);
    } else if (o.after === undefined) {
      out.push(`${pad(indent)}- ${name} = ${o.sensitive ? '(sensitive value)' : isCollection(o.before) ? (Array.isArray(o.before) ? '[...]' : '{...}') : prim(o.before)} -> null`);
    } else if (o.sensitive) {
      out.push(`${pad(indent)}~ ${name} = (sensitive value)`);
    } else if (isCollection(o.before) || isCollection(o.after)) {
      if (isCollection(o.before) && isCollection(o.after)) out.push(`${pad(indent)}~ ${name} = ${Array.isArray(o.after) ? '[' : '{'}`, ...collectionDiff(o.before, o.after, indent + 2, false), `${pad(indent + 2)}${Array.isArray(o.after) ? ']' : '}'}`);
      else out.push(`${pad(indent)}~ ${name} = ${isCollection(o.before) ? '[...]' : prim(o.before)} -> ${isCollection(o.after) ? (Array.isArray(o.after) ? '[' : '{') : prim(o.after)}`);
    } else out.push(`${pad(indent)}~ ${name} = ${prim(o.before)} -> ${prim(o.after)}`);
  }
  return out;
}

export interface PlanRenderOptions {
  destroy?: boolean;
  refreshOnly?: boolean;
  /** "terraform apply" and "destroy" print the plan without the -out note. */
  forApply?: boolean;
  savedTo?: string;
}

/** The whole plan text after refresh lines: drift, actions, summary, output changes. */
export function renderPlan(run: Run, o: PlanRenderOptions): { lines: string[]; empty: boolean } {
  const lines: string[] = [];
  const changes = [...run.changes.values()].sort((a, b) => a.addr.localeCompare(b.addr, undefined, { numeric: true }));
  const shown = changes.filter((c) => c.action !== 'noop' || c.importId !== undefined || run.moved.some((m) => m.to === c.addr));
  if (run.drift.length && (o.refreshOnly || shown.length || true)) {
    lines.push('', 'Note: Objects have changed outside of Terraform', '');
    if (o.refreshOnly) lines.push('Terraform detected the following changes made outside of Terraform since the', 'last "terraform apply":', '');
    else lines.push('Terraform detected the following changes made outside of Terraform since the', 'last "terraform apply" which may have affected this plan:', '');
    for (const d of run.drift) lines.push(...driftLines(run, d), '');
    if (o.refreshOnly) {
      lines.push('This is a refresh-only plan, so Terraform will not take any actions to undo', 'these. If you were expecting these changes then you can apply this plan to', 'record the updated values in the Terraform state without changing any remote', 'objects.');
    } else {
      lines.push('', 'Unless you have made equivalent changes to your configuration, or ignored the', 'relevant attributes using ignore_changes, the following plan may include', 'actions to undo or respond to these changes.', '', RULE);
    }
  }
  if (o.refreshOnly) {
    if (!run.drift.length) {
      lines.push('', 'No changes. Your infrastructure still matches the configuration.', '', 'Terraform has checked that the real remote objects still match the result of', 'your most recent changes, and found no differences.');
      return { lines, empty: true };
    }
    return { lines, empty: false };
  }
  const outputChanges = outputLines(run.outputs);
  if (!shown.length) {
    if (o.destroy) {
      lines.push('', 'No changes. No objects need to be destroyed.', '', 'Either you have not created any objects yet or the existing objects were', 'already deleted outside of Terraform.');
      return { lines, empty: true };
    }
    if (outputChanges.length) {
      lines.push('', 'Changes to Outputs:', ...outputChanges, '', 'You can apply this plan to save these new output values to the Terraform', 'state, without changing any real infrastructure.');
      return { lines, empty: false };
    }
    lines.push('', 'No changes. Your infrastructure matches the configuration.', '', 'Terraform has compared your real infrastructure against your configuration', 'and found no differences, so no changes are needed.');
    return { lines, empty: true };
  }
  const acts = new Set(shown.map((c) => (c.action === 'replace' ? (c.cbd ? '+/-' : '-/+') : c.action)));
  const legend: string[] = [];
  if (acts.has('create')) legend.push('  + create');
  if (acts.has('update')) legend.push('  ~ update in-place');
  if (acts.has('delete')) legend.push('  - destroy');
  if (acts.has('-/+')) legend.push('-/+ destroy and then create replacement');
  if (acts.has('+/-')) legend.push('+/- create replacement and then destroy');
  if (acts.has('read')) legend.push(' <= read (data resources)');
  if (acts.has('forget')) legend.push(' . forget');
  if (legend.length) {
    lines.push('', 'Terraform used the selected providers to generate the following execution', 'plan. Resource actions are indicated with the following symbols:', ...legend);
  }
  lines.push('', 'Terraform will perform the following actions:', '');
  for (const c of shown) lines.push(...changeLines(run, c), '');
  const add = shown.filter((c) => c.action === 'create' || c.action === 'replace').length;
  const change = shown.filter((c) => c.action === 'update').length;
  const destroy = shown.filter((c) => c.action === 'delete' || c.action === 'replace').length;
  const imports = shown.filter((c) => c.importId !== undefined).length;
  const forget = shown.filter((c) => c.action === 'forget').length;
  lines.push(`Plan: ${imports ? `${imports} to import, ` : ''}${add} to add, ${change} to change, ${destroy} to destroy${forget ? `, ${forget} to forget` : ''}.`);
  if (outputChanges.length) lines.push('', 'Changes to Outputs:', ...outputChanges);
  return { lines, empty: false };
}

export function planNote(savedTo?: string): string[] {
  if (savedTo) {
    return ['', RULE, '', `Saved the plan to: ${savedTo}`, '', 'To perform exactly these actions, run the following command to apply:', `    terraform apply "${savedTo}"`];
  }
  return ['', RULE, '', 'Note: You didn\'t use the -out option to save this plan, so Terraform can\'t', 'guarantee to take exactly these actions if you run "terraform apply" now.'];
}

/** `terraform output` style rendering of root outputs. */
export function renderOutputs(outputs: Record<string, { value: Val; sensitive?: boolean }>): string[] {
  const out: string[] = [];
  for (const [name, o] of Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b))) {
    if (o.sensitive) {
      out.push(`${name} = <sensitive>`);
      continue;
    }
    const r = renderValue(o.value);
    out.push(`${name} = ${r[0]}`, ...r.slice(1));
  }
  return out;
}

/** `terraform state show` rendering of one instance. */
export function renderInstance(inst: Inst, run?: Run): string[] {
  const ctx = ctxFor(run, inst.provider, inst.type, inst.sensitive, [], []);
  const kw = inst.mode === 'data' ? 'data' : 'resource';
  const out = [`# ${inst.addr}:`, `${kw} "${inst.type}" "${inst.name}" {`];
  const attrs = Object.keys(inst.attrs).filter((k) => !ctx.blocks.has(k) && inst.attrs[k] !== null).sort();
  const width = Math.max(0, ...attrs.map((k) => k.length));
  for (const k of attrs) {
    const v = inst.attrs[k];
    if (ctx.sensitive.has(k)) {
      out.push(`    ${k.padEnd(width)} = (sensitive value)`);
      continue;
    }
    if (isCollection(v) && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
      const r = renderValue(v, '    ');
      out.push(`    ${k.padEnd(width)} = ${r[0].replace(/^tomap\(\{/, '{')}`, ...r.slice(1).map((l) => l.replace(/^(\s*)\}\)$/, '$1}')));
    } else out.push(`    ${k.padEnd(width)} = ${isCollection(v) ? (Array.isArray(v) ? '[]' : '{}') : typeof v === 'string' && v.includes('\n') ? JSON.stringify(v) : prim(v)}`);
  }
  for (const b of [...ctx.blocks].sort()) {
    for (const item of (inst.attrs[b] as ValObject[] | null) ?? []) {
      out.push('', `    ${b} {`);
      const keys = Object.keys(item).filter((k) => item[k] !== null).sort();
      const w = Math.max(0, ...keys.map((k) => k.length));
      for (const k of keys) {
        const v = item[k];
        if (Array.isArray(v)) out.push(`        ${k.padEnd(w)} = [`, ...v.map((x) => `            ${prim(x)},`), '        ]');
        else out.push(`        ${k.padEnd(w)} = ${prim(v)}`);
      }
      out.push('    }');
    }
  }
  out.push('}');
  return out;
}
