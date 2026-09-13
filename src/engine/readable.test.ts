import { describe, expect, it } from 'vitest';
import { labs, labNetwork } from '../content';
import { checkLabel, grade, readable } from './grader';

describe('turning a check pattern into an instruction', () => {
  it('drops the anchors', () => {
    expect(readable('^pwd$')).toBe('pwd');
  });

  it('drops optional groups, leaving a command that can be typed', () => {
    // "do" is allowed from config mode but is not part of the instruction.
    expect(readable('^(do )?show vlan( brief)?$')).toBe('show vlan');
    expect(readable('^(do )?show etherchannel( \\d+)? summary$')).toBe('show etherchannel summary');
    expect(readable('^(do )?show (ip )?access-lists')).toBe('show access-lists');
    expect(readable('^(sudo )?systemctl status nginx')).toBe('systemctl status nginx');
  });

  it('names what the learner has to supply instead of losing the backslash', () => {
    // The bug this replaces printed "man S+", which learners typed verbatim.
    expect(readable('^man \\S+$')).toBe('man …');
    expect(readable('^vlan \\d+$')).toBe('vlan a number');
    expect(readable('^curl\\b.*192\\.168\\.1\\.50')).toBe('curl … 192.168.1.50');
  });

  it('reads a group of alternatives as a list', () => {
    expect(readable('^(write|copy running-config startup-config)$')).toBe('write or copy running-config startup-config');
    expect(readable('^(ps|top|pgrep)$')).toBe('ps, top or pgrep');
  });

  it('keeps an optional character rather than leaving a question mark behind', () => {
    expect(readable('^python3? --version$')).toBe('python3 --version');
    expect(readable('^cd /var/log/?$')).toBe('cd /var/log/');
  });

  it('leaves a real question mark and a real dollar alone', () => {
    // "echo $?" prints the exit code; both characters are literal.
    expect(readable('^echo \\$\\?$')).toBe('echo $?');
    expect(readable('^\\?$')).toBe('?');
  });

  it('leaves an escaped dot as a dot', () => {
    expect(readable('^ping 8\\.8\\.8\\.8$')).toBe('ping 8.8.8.8');
  });
});

describe('every objective a learner can read', () => {
  /**
   * The marks of a regex that leaked through rather than of a command worth typing.
   * Brackets, stars and question marks are not among them, because real commands and
   * real config carry those: "if [", "echo $?", "<VirtualHost *:80>".
   */
  const REGEX_JUNK = /\\|\)\?|\||\b[Sdws]\+/;

  it('never builds a label that is really a regex', () => {
    const bad: string[] = [];
    for (const lab of labs) {
      for (const o of lab.objectives) {
        for (const c of o.checks) {
          if (c.label) continue;
          const built = checkLabel(c);
          if (REGEX_JUNK.test(built)) bad.push(`${lab.id}: ${built}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('never shows an empty label', () => {
    for (const lab of labs) {
      for (const o of grade(lab.objectives, labNetwork(lab)).objectives) {
        expect(o.label.trim(), lab.id).not.toBe('');
        for (const c of o.checks) expect(c.label.trim(), `${lab.id} / ${o.label}`).not.toBe('');
      }
    }
  });
});
