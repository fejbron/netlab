import { describe, expect, it } from 'vitest';
import { complete, help, resolve, type CommandDef } from './resolver';

type Ctx = { log: string[] };

const defs: CommandDef<Ctx>[] = [
  { pattern: 'show running-config', help: 'run', run: (c) => void c.log.push('run') },
  { pattern: 'show startup-config', help: 'start', run: (c) => void c.log.push('start') },
  { pattern: 'show spanning-tree', help: 'stp', run: (c) => void c.log.push('stp') },
  { pattern: 'show interfaces status', help: 'status', run: (c) => void c.log.push('status') },
  { pattern: 'show interfaces <interface> switchport', help: 'swp', run: (c, a) => void c.log.push(`swp:${a.interface}`) },
  { pattern: 'configure terminal', help: 'conf', run: (c) => void c.log.push('conf') },
  { pattern: 'hostname <name>', help: 'host', run: (c, a) => void c.log.push(`host:${a.name}`) },
  { pattern: 'banner motd <text...>', help: 'banner', run: (c, a) => void c.log.push(`banner:${a.text}`) },
  { pattern: 'switchport trunk allowed vlan <list>', help: 'allowed', run: (c, a) => void c.log.push(`allowed:${a.list}`) },
  { pattern: 'switchport trunk allowed vlan add <list>', help: 'add', run: (c, a) => void c.log.push(`add:${a.list}`) },
  { pattern: 'switchport trunk allowed vlan all', help: 'all', run: (c) => void c.log.push('all') },
];

function run(line: string) {
  const res = resolve(defs, line.split(/\s+/));
  const ctx: Ctx = { log: [] };
  if (res.kind === 'ok') res.def.run(ctx, res.args);
  return { res, log: ctx.log };
}

describe('resolve', () => {
  it('expands unique prefixes', () => {
    const { res, log } = run('conf t');
    expect(res.kind).toBe('ok');
    expect(res.kind === 'ok' && res.canonical).toBe('configure terminal');
    expect(log).toEqual(['conf']);
  });

  it('reports ambiguous prefixes', () => {
    const { res } = run('sh st');
    expect(res).toMatchObject({ kind: 'ambiguous', index: 1, options: ['startup-config', 'spanning-tree'].sort() });
  });

  it('resolves once the prefix is unique', () => {
    expect(run('sh star').log).toEqual(['start']);
    expect(run('sh sp').log).toEqual(['stp']);
    expect(run('sh run').log).toEqual(['run']);
  });

  it('reports incomplete commands', () => {
    expect(run('hostname').res.kind).toBe('incomplete');
    expect(run('show').res.kind).toBe('incomplete');
  });

  it('reports invalid input with the failing word index', () => {
    expect(run('shwo run').res).toMatchObject({ kind: 'invalid', index: 0 });
    expect(run('show runn-config').res).toMatchObject({ kind: 'invalid', index: 1 });
    expect(run('hostname SW1 extra').res).toMatchObject({ kind: 'invalid', index: 2 });
  });

  it('prefers literals over parameters', () => {
    expect(run('show interfaces status').log).toEqual(['status']);
    expect(run('show interfaces g0/1 switchport').log).toEqual(['swp:g0/1']);
    expect(run('switchport trunk allowed vlan add 10').log).toEqual(['add:10']);
    expect(run('switchport trunk allowed vlan 10,20').log).toEqual(['allowed:10,20']);
    expect(run('switchport trunk allowed vlan al').log).toEqual(['all']);
    expect(run('switchport trunk allowed vlan a').res.kind).toBe('ambiguous');
  });

  it('captures the rest of the line for rest parameters', () => {
    expect(run('banner motd # Authorized access only #').log).toEqual(['banner:# Authorized access only #']);
  });

  it('is case-insensitive for keywords but preserves argument case', () => {
    expect(run('HOSTNAME Branch-SW1').log).toEqual(['host:Branch-SW1']);
  });
});

describe('help and completion', () => {
  it('lists completions for a partial word', () => {
    const words = help(defs, ['sh'], true).map((e) => e.word);
    expect(words).toEqual(['show']);
    const shows = help(defs, ['show', 's'], true).map((e) => e.word);
    expect(shows).toEqual(['spanning-tree', 'startup-config']);
  });

  it('lists what may follow a complete word', () => {
    const words = help(defs, ['show'], false).map((e) => e.word);
    expect(words).toEqual(['interfaces', 'running-config', 'spanning-tree', 'startup-config']);
    const after = help(defs, ['show', 'interfaces'], false).map((e) => e.word);
    expect(after).toEqual(['<interface>', 'status']);
  });

  it('shows <cr> when the command can end here', () => {
    const entries = help(defs, ['configure', 'terminal'], false).map((e) => e.word);
    expect(entries).toEqual(['<cr>']);
  });

  it('completes unique prefixes only', () => {
    expect(complete(defs, ['conf'])).toBe('configure');
    expect(complete(defs, ['show', 'st'])).toBeNull();
    expect(complete(defs, ['show', 'star'])).toBe('startup-config');
  });
});
