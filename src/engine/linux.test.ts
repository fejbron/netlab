import { describe, expect, it } from 'vitest';
import { evaluateCheck } from './grader';
import { applyPythonResult, buildNetwork, createRouter, executeHost, hostPrompt, type NetworkState } from './index';

/** SRV1 (Linux) - R1 g0/0 192.168.1.1 with RESTCONF enabled. */
function site(): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false } },
    overrides: { httpSecureServer: true, httpAuthLocal: true, restconf: true, users: [{ username: 'netops', password: 'Aut0mate!', secret: true, privilege: 15 }] },
  });
  return buildNetwork({
    primary: 'R1',
    devices: [r1],
    hosts: [{ id: 'SRV1', ip: '192.168.1.50', mask: '255.255.255.0', gateway: '192.168.1.1', linux: { hostname: 'web1', files: { '~/notes.txt': 'alpha\nbeta\ngamma\n', '/var/log/app.log': 'INFO start\nERROR disk full\nINFO retry\nERROR timeout\n' }, services: { nginx: { active: false, enabled: false } } } }],
    links: [['SRV1', 'R1:g0/0']],
  });
}

function sh(net: NetworkState, ...lines: string[]): { net: NetworkState; out: string[] } {
  let out: string[] = [];
  let n = net;
  for (const l of lines) {
    const r = executeHost(n, 'SRV1', l);
    n = r.network;
    out = r.output;
  }
  return { net: n, out };
}

const run = (net: NetworkState, ...lines: string[]) => sh(net, ...lines).net;
const out = (net: NetworkState, ...lines: string[]) => sh(net, ...lines).out;

describe('Linux shell basics', () => {
  it('shows a bash prompt and navigates the filesystem', () => {
    let net = site();
    expect(hostPrompt(net.hosts.SRV1)).toBe('student@web1:~$ ');
    expect(out(net, 'pwd')).toEqual(['/home/student']);
    expect(out(net, 'ls')).toEqual(['notes.txt']);
    expect(out(net, 'ls -a')).toEqual(['.bashrc  notes.txt']);
    net = run(net, 'cd /var/log');
    expect(hostPrompt(net.hosts.SRV1)).toBe('student@web1:/var/log$ ');
    expect(out(net, 'cat app.log | grep ERROR')).toEqual(['ERROR disk full', 'ERROR timeout']);
    expect(out(net, 'grep -c ERROR app.log')).toEqual(['2']);
    expect(out(net, 'cd nowhere')).toEqual(['bash: cd: nowhere: No such file or directory']);
    expect(out(net, 'cd ~ && pwd')).toEqual(['/home/student']);
  });

  it('handles quoting, variables, substitution and arithmetic', () => {
    const net = site();
    expect(out(net, 'echo "hello   world" \'$HOME\' $HOME')).toEqual(['hello   world $HOME /home/student']);
    expect(out(net, 'name=NetLab; echo "Hi, ${name}!"; echo ${missing:-default}')).toEqual(['Hi, NetLab!', 'default']);
    expect(out(net, 'echo $((3 * (4 + 2)))')).toEqual(['18']);
    expect(out(net, 'echo "there are $(ls | wc -l) files"')).toEqual(['there are 1 files']);
    expect(out(net, 'x=abc.txt; echo ${x%.txt} ${#x} ${x^^}')).toEqual(['abc 7 ABC.TXT']);
    expect(out(net, 'false; echo $?; true; echo $?')).toEqual(['1', '0']);
    expect(out(net, 'nosuchcmd')).toEqual(['bash: nosuchcmd: command not found']);
    expect(out(net, 'echo one && echo two || echo three')).toEqual(['one', 'two']);
    expect(out(net, 'false || echo fallback')).toEqual(['fallback']);
  });

  it('redirects, appends, pipes and reads heredocs across lines', () => {
    let net = run(site(), 'echo first > out.txt', 'echo second >> out.txt');
    expect(out(net, 'cat out.txt')).toEqual(['first', 'second']);
    expect(out(net, 'wc -l < out.txt')).toEqual(['2']);
    expect(out(net, 'ls nothing 2> /dev/null; echo done')).toEqual(['done']);
    expect(out(net, 'ls nothing 2>&1 | grep -c cannot')).toEqual(['1']);
    net = run(net, "cat > hello.sh << 'EOF'");
    expect(hostPrompt(net.hosts.SRV1)).toBe('> ');
    net = run(net, '#!/bin/bash', 'echo "Hello, $1!"', 'EOF');
    expect(hostPrompt(net.hosts.SRV1)).toBe('student@web1:~$ ');
    expect(out(net, 'cat hello.sh')).toEqual(['#!/bin/bash', 'echo "Hello, $1!"']);
    expect(out(net, './hello.sh World')).toEqual(['bash: ./hello.sh: Permission denied']);
    net = run(net, 'chmod +x hello.sh');
    expect(out(net, 'ls -l hello.sh')[0]).toMatch(/^-rwxr-xr-x 1 student  student /);
    expect(out(net, './hello.sh World')).toEqual(['Hello, World!']);
    expect(out(net, 'bash hello.sh Linux')).toEqual(['Hello, Linux!']);
  });

  it('runs loops, conditionals, case and functions, including multi-line input', () => {
    let net = site();
    expect(out(net, 'for i in 1 2 3; do echo "n=$i"; done')).toEqual(['n=1', 'n=2', 'n=3']);
    expect(out(net, 'for f in *.txt; do echo $f; done')).toEqual(['notes.txt']);
    expect(out(net, 'if [ -f notes.txt ]; then echo yes; else echo no; fi')).toEqual(['yes']);
    expect(out(net, 'if [ 3 -gt 5 ]; then echo big; elif [ 3 -eq 3 ]; then echo three; fi')).toEqual(['three']);
    expect(out(net, 'i=0; while [ $i -lt 3 ]; do i=$((i+1)); echo $i; done')).toEqual(['1', '2', '3']);
    expect(out(net, 'case "web1" in web*) echo web;; *) echo other;; esac')).toEqual(['web']);
    net = run(net, 'greet() {');
    expect(hostPrompt(net.hosts.SRV1)).toBe('> ');
    net = run(net, '  local who=$1', '  echo "hi $who"', '  return 3', '}');
    expect(out(net, 'greet bob; echo $?')).toEqual(['hi bob', '3']);
    expect(out(net, 'cat notes.txt | while read line; do echo "[$line]"; done')).toEqual(['[alpha]', '[beta]', '[gamma]']);
    expect(out(net, 'seq 1 5 | awk \'{ s += $1 } END { print s }\'')).toEqual(['15']);
    expect(out(net, 'printf "%-5s|%3d\\n" ab 7')).toEqual(['ab   |  7']);
    expect(out(net, '[[ "abc" == a* ]] && echo glob')).toEqual(['glob']);
  });

  it('has the usual text tools', () => {
    const net = site();
    expect(out(net, "cut -d: -f1 /etc/passwd | head -3")).toEqual(['root', 'daemon', 'www-data']);
    expect(out(net, 'awk -F: \'$3 >= 1000 { print $1 }\' /etc/passwd')).toEqual(['nobody', 'student']);
    expect(out(net, "sed 's/a/A/g' notes.txt")).toEqual(['AlphA', 'betA', 'gAmmA']);
    expect(out(net, 'sort -r notes.txt | head -1')).toEqual(['gamma']);
    expect(out(net, 'echo -e "b\\na\\nb" | sort | uniq -c')).toEqual(['      1 a', '      2 b']);
    expect(out(net, 'echo hello | tr a-z A-Z')).toEqual(['HELLO']);
    expect(out(net, 'grep -n beta notes.txt')).toEqual(['2:beta']);
    expect(out(net, 'find / -name "*.log" -type f')).toEqual(['/var/log/app.log', '/var/log/auth.log']);
    expect(out(net, 'grep -c "Failed password" /var/log/auth.log')).toEqual(['4']);
    expect(out(net, "awk '/Failed password/ {print $(NF-3)}' /var/log/auth.log | sort | uniq -c | sort -rn | head -1")).toEqual(['      3 203.0.113.45']);
  });
});

describe('Linux permissions, users and services', () => {
  it('enforces root for system changes and honours sudo', () => {
    let net = site();
    expect(out(net, 'echo x > /etc/motd')).toEqual(['bash: /etc/motd: Permission denied']);
    expect(out(net, 'cat /etc/shadow')).toEqual(['cat: /etc/shadow: Permission denied']);
    expect(out(net, 'useradd bob')).toEqual(['useradd: Permission denied.', 'useradd: cannot lock /etc/passwd; try again later.']);
    expect(out(net, 'systemctl start nginx')[0]).toBe('Failed to start nginx.service: Interactive authentication required.');
    net = run(net, 'sudo useradd -m -s /bin/bash -G sudo bob', 'sudo systemctl enable --now nginx');
    expect(net.hosts.SRV1.linux!.users.find((u) => u.name === 'bob')).toMatchObject({ shell: '/bin/bash', groups: ['sudo'], home: '/home/bob' });
    expect(net.hosts.SRV1.linux!.services.nginx).toMatchObject({ active: true, enabled: true });
    expect(out(net, 'systemctl is-active nginx')).toEqual(['active']);
    expect(out(net, 'ss -tlnp').join('\n')).toContain('0.0.0.0:80');
    expect(out(net, 'ps aux | grep -c nginx')).toEqual(['1']);
    expect(out(net, 'whoami')).toEqual(['student']);
    expect(evaluateCheck({ type: 'linux-user', device: 'SRV1', name: 'bob', groups: ['sudo'], shell: '/bin/bash' }, net)).toBe(true);
    expect(evaluateCheck({ type: 'service', device: 'SRV1', name: 'nginx', active: true, enabled: true }, net)).toBe(true);
    expect(evaluateCheck({ type: 'process', device: 'SRV1', pattern: 'nginx' }, net)).toBe(true);
  });

  it('runs a root shell with sudo -i, sets passwords interactively, and returns with exit', () => {
    let net = run(site(), 'sudo -i');
    expect(hostPrompt(net.hosts.SRV1)).toBe('root@web1:~# ');
    net = run(net, 'useradd -m alice', 'passwd alice');
    expect(hostPrompt(net.hosts.SRV1)).toBe('New password: ');
    net = run(net, 'Secr3t-pass');
    expect(hostPrompt(net.hosts.SRV1)).toBe('Retype new password: ');
    const r = executeHost(net, 'SRV1', 'Secr3t-pass');
    expect(r.output).toEqual(['passwd: password updated successfully']);
    net = r.network;
    expect(net.hosts.SRV1.linux!.users.find((u) => u.name === 'alice')?.password).toBe('Secr3t-pass');
    expect(net.hosts.SRV1.commandHistory).not.toContain('Secr3t-pass');
    expect(out(net, 'cat /etc/shadow | grep -c alice')).toEqual(['1']);
    net = run(net, 'exit');
    expect(hostPrompt(net.hosts.SRV1)).toBe('student@web1:~$ ');
    expect(evaluateCheck({ type: 'linux-user', device: 'SRV1', name: 'alice', hasPassword: true }, net)).toBe(true);
  });

  it('respects file ownership and mode for other users', () => {
    let net = run(site(), 'sudo useradd -m carol', 'echo secret > private.txt', 'chmod 600 private.txt', 'sudo chown carol:carol private.txt');
    expect(out(net, 'cat private.txt')).toEqual(['cat: private.txt: Permission denied']);
    expect(out(net, 'stat -c "%a %U" private.txt')).toEqual(['600 carol']);
    net = run(net, 'sudo chmod 644 private.txt');
    expect(out(net, 'cat private.txt')).toEqual(['secret']);
    expect(evaluateCheck({ type: 'file', device: 'SRV1', path: '~/private.txt', mode: '644', owner: 'carol', contains: '^secret$' }, net)).toBe(true);
    expect(evaluateCheck({ type: 'file', device: 'SRV1', path: 'private.txt', mode: '600' }, net)).toBe(false);
  });

  it('installs packages with apt and creates their services', () => {
    let net = site();
    expect(out(net, 'apt install tree')[0]).toMatch(/Permission denied/);
    net = run(net, 'sudo apt install -y tree jq');
    expect(net.hosts.SRV1.linux!.packages).toContain('tree');
    expect(out(net, 'tree /var/log').slice(0, 2)).toEqual(['/var/log', '├── app.log']);
    expect(out(net, 'echo \'{"a":{"b":[1,2]}}\' | jq .a.b[1]')).toEqual(['2']);
    expect(out(net, 'sudo apt install nosuchpkg').pop()).toBe('E: Unable to locate package nosuchpkg');
    expect(evaluateCheck({ type: 'package', device: 'SRV1', name: 'jq' }, net)).toBe(true);
  });
});

describe('Linux networking', () => {
  it('shows addresses and routes, pings through the simulation and talks RESTCONF with curl', () => {
    const net = site();
    expect(out(net, 'ip -br addr')[1]).toMatch(/^eth0\s+UP\s+192\.168\.1\.50\/24$/);
    expect(out(net, 'ip route')[0]).toBe('default via 192.168.1.1 dev eth0 proto static metric 100');
    const ping = out(net, 'ping -c 2 192.168.1.1');
    expect(ping[1]).toMatch(/^64 bytes from 192\.168\.1\.1: icmp_seq=1 ttl=64/);
    expect(ping).toContain('2 packets transmitted, 2 received, 0% packet loss, time 1003ms');
    expect(out(net, 'ping -c 1 192.168.9.9').pop()).toBe('1 packets transmitted, 0 received, 100% packet loss, time 3ms');
    const after = run(net, 'ping -c 1 192.168.1.1');
    expect(evaluateCheck({ type: 'ping', device: 'SRV1', target: '192.168.1.1', success: true }, after)).toBe(true);
    const json = out(net, 'curl -s -k -u netops:Aut0mate! https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0');
    expect(json.join('\n')).toContain('"ip": "192.168.1.1"');
    expect(out(net, 'hostname -I')).toEqual(['192.168.1.50']);
  });
});

describe('python3 hand-off', () => {
  it('returns a pending request and folds the result back into the host', () => {
    let net = run(site(), "cat > count.py << 'EOF'", 'import sys', 'lines = open("notes.txt").read().splitlines()', 'print(len(lines))', 'open("count.txt", "w").write(str(len(lines)))', 'EOF');
    const r = executeHost(net, 'SRV1', 'python3 count.py > result.txt');
    expect(r.pending).toMatchObject({ kind: 'python', argv: ['count.py'], cwd: '/home/student', user: 'student', redirect: { path: '/home/student/result.txt', append: false } });
    expect(r.pending!.files['/home/student/notes.txt']).toBe('alpha\nbeta\ngamma\n');
    expect(r.pending!.code).toContain('splitlines');
    const applied = applyPythonResult(r.network, 'SRV1', r.pending!, { stdout: '3\n', stderr: '', exitCode: 0, files: { '/home/student/count.txt': '3' } });
    net = applied.network;
    expect(applied.output).toEqual([]);
    expect(out(net, 'cat result.txt count.txt')).toEqual(['3', '3']);
    expect(evaluateCheck({ type: 'python-run', device: 'SRV1', file: 'count.py', pattern: '^3$' }, net)).toBe(true);
    expect(evaluateCheck({ type: 'file', device: 'SRV1', path: 'count.py', contains: 'open\\(' }, net)).toBe(true);
    const failed = applyPythonResult(net, 'SRV1', { ...r.pending!, redirect: undefined }, { stdout: '', stderr: 'Traceback (most recent call last):\n  File "count.py", line 2\nNameError: x\n', exitCode: 1, files: {} });
    expect(failed.output[0]).toBe('Traceback (most recent call last):');
    expect(failed.network.hosts.SRV1.linux!.lastExit).toBe(1);
  });

  it('refuses the interactive interpreter and pipelines', () => {
    const net = site();
    expect(out(net, 'python3')[0]).toMatch(/interactive interpreter is not simulated/);
    expect(executeHost(net, 'SRV1', 'python3 -c "print(1)" | cat').output[0]).toMatch(/cannot be part of a pipeline/);
    expect(out(net, 'echo \'{"x": 1}\' | python3 -m json.tool')).toEqual(['{', '    "x": 1', '}']);
  });
});
