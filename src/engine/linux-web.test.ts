import { describe, expect, it } from 'vitest';
import { evaluateCheck, type Check } from './grader';
import { buildNetwork, createRouter, createSwitch, executeHost, makeCertificate, parseCertificate, type NetworkState } from './index';

/**
 * web1 (nginx) and PC-A share a switch on 192.168.1.0/24 behind R1; app1 sits on R1's second
 * LAN and app2 behind R2, so a proxied request really crosses the routed network.
 */
function site(opts: { nginxActive?: boolean; conf?: string; app2Down?: boolean } = {}): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    ports: 3,
    interfaces: {
      'g0/0': { ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false },
      'g0/1': { ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false },
      'g0/2': { ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false },
    },
    staticRoutes: [{ destination: '192.168.3.0', mask: '255.255.255.0', nextHop: '10.0.0.2' }],
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/0': { ipAddress: '192.168.3.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } },
    staticRoutes: [{ destination: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.0.1' }],
  });
  const sw1 = createSwitch({ hostname: 'SW1', ports: 4 });
  const app = (hostname: string, active: boolean) => ({ hostname, packages: ['netlab-app'], services: { app: { active, enabled: true } } });
  return buildNetwork({
    primary: 'web1',
    devices: [r1, r2, sw1],
    hosts: [
      {
        id: 'web1',
        ip: '192.168.1.50',
        mask: '255.255.255.0',
        gateway: '192.168.1.1',
        linux: {
          hostname: 'web1',
          packages: ['nginx', 'openssl'],
          services: { nginx: { active: Boolean(opts.nginxActive), enabled: false } },
          files: { '/var/www/netlab/index.html': '<h1>NetLab site</h1>\n', '/etc/hosts': '127.0.0.1 localhost\n127.0.0.1 netlab.lab.local lb.lab.local\n192.168.2.50 app1\n192.168.3.50 app2\n', ...(opts.conf ? { '/etc/nginx/conf.d/netlab.conf': opts.conf } : {}) },
        },
      },
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'app1', ip: '192.168.2.50', mask: '255.255.255.0', gateway: '192.168.2.1', linux: app('app1', true) },
      { id: 'app2', ip: '192.168.3.50', mask: '255.255.255.0', gateway: '192.168.3.1', linux: app('app2', !opts.app2Down) },
    ],
    links: [['web1', 'SW1:g0/1'], ['PC-A', 'SW1:g0/2'], ['SW1:g0/4', 'R1:g0/0'], ['app1', 'R1:g0/1'], ['R1:g0/2', 'R2:g0/1'], ['app2', 'R2:g0/0']],
  });
}

/** A stateful console: every command keeps its effect, so request logs accumulate as they would in a lab. */
function shell(initial: NetworkState) {
  let net = initial;
  const step = (raw: string): string[] => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m && net.hosts[m[1]] ? m[1] : 'web1';
    const line = m && net.hosts[m[1]] ? m[2] : raw;
    const r = executeHost(net, node, line);
    net = r.network;
    return r.output;
  };
  return {
    /** Run commands, keep only the last output. */
    run: (...lines: string[]) => lines.map(step).pop() ?? [],
    out: (line: string) => step(line),
    get net() {
      return net;
    },
    check: (c: Check) => evaluateCheck(c, net),
    linux: (id: string) => net.hosts[id].linux!,
  };
}

const SITE = ['server {', '    listen 80;', '    server_name netlab.lab.local;', '    root /var/www/netlab;', '    index index.html;', '}'];
const heredoc = (file: string, ...lines: string[]) => [`sudo tee ${file} << 'EOF'`, ...lines, 'EOF'];

describe('nginx configuration', () => {
  it('ships the Debian layout and passes nginx -t out of the box', () => {
    const sh = shell(site());
    expect(sh.out('ls /etc/nginx')).toEqual(['conf.d  mime.types  modules-enabled  nginx.conf  sites-available  sites-enabled  snippets']);
    expect(sh.out('readlink /etc/nginx/sites-enabled/default')).toEqual(['/etc/nginx/sites-available/default']);
    expect(sh.out('sudo nginx -t')).toEqual(['nginx: the configuration file /etc/nginx/nginx.conf syntax is ok', 'nginx: configuration file /etc/nginx/nginx.conf test is successful']);
    expect(sh.out('nginx -t')[0]).toMatch(/\[warn\] the "user" directive/);
  });

  it('reports syntax errors with file and line, and refuses to start until fixed', () => {
    const sh = shell(site());
    sh.run(...heredoc('/etc/nginx/conf.d/bad.conf', 'server {', '    listen 80;', '    servr_name x;', '}'));
    expect(sh.out('sudo nginx -t')).toEqual(['nginx: [emerg] unknown directive "servr_name" in /etc/nginx/conf.d/bad.conf:3', 'nginx: configuration file /etc/nginx/nginx.conf test failed']);
    sh.run(...heredoc('/etc/nginx/conf.d/bad.conf', 'server {', '    listen 80;', '    root /var/www/x', '    index index.html;', '}'));
    expect(sh.out('sudo nginx -t')[0]).toBe('nginx: [emerg] invalid number of arguments in "root" directive in /etc/nginx/conf.d/bad.conf:3');
    sh.run(...heredoc('/etc/nginx/conf.d/bad.conf', 'server {', '    listen 80;'));
    expect(sh.out('sudo nginx -t')[0]).toMatch(/unexpected end of file, expecting "}" in \/etc\/nginx\/conf\.d\/bad\.conf:2/);
    expect(sh.out('sudo systemctl start nginx')[0]).toBe('Job for nginx.service failed because the control process exited with error code.');
    expect(sh.linux('web1').services.nginx.active).toBe(false);
    expect(sh.out('systemctl status nginx').join('\n')).toContain('nginx: [emerg]');
    expect(sh.check({ type: 'nginx-config', device: 'web1', valid: false })).toBe(true);
    sh.run('sudo rm /etc/nginx/conf.d/bad.conf', 'sudo systemctl start nginx');
    expect(sh.linux('web1').services.nginx.active).toBe(true);
    expect(sh.check({ type: 'nginx-config', device: 'web1', valid: true })).toBe(true);
  });

  it('keeps serving the old configuration when a reload fails', () => {
    const sh = shell(site({ nginxActive: true, conf: SITE.join('\n') + '\n' }));
    expect(sh.out('curl -s http://netlab.lab.local')).toEqual(['<h1>NetLab site</h1>']);
    sh.run(...heredoc('/etc/nginx/conf.d/netlab.conf', 'server {', '    listen 80;', '    servr_name netlab.lab.local;', '}'));
    expect(sh.out('sudo systemctl reload nginx')[0]).toMatch(/Job for nginx.service failed/);
    expect(sh.out('curl -s http://netlab.lab.local')).toEqual(['<h1>NetLab site</h1>']);
    expect(sh.linux('web1').services.nginx.active).toBe(true);
  });
});

describe('virtual hosts and static files', () => {
  it('routes by Host header, falls back to the default server, and serves 404 pages', () => {
    const sh = shell(site());
    sh.run(
      'sudo mkdir -p /var/www/shop',
      "echo '<h1>Shop</h1>' | sudo tee /var/www/shop/index.html",
      ...heredoc('/etc/nginx/sites-available/netlab.conf', ...SITE),
      'sudo ln -s /etc/nginx/sites-available/netlab.conf /etc/nginx/sites-enabled/',
      ...heredoc('/etc/nginx/conf.d/shop.conf', 'server {', '    listen 80;', '    server_name shop.lab.local;', '    root /var/www/shop;', '}'),
      'sudo systemctl enable --now nginx',
    );
    expect(sh.out('ls -l /etc/nginx/sites-enabled')[2]).toMatch(/netlab\.conf -> \/etc\/nginx\/sites-available\/netlab\.conf$/);
    expect(sh.out('curl -s -H "Host: netlab.lab.local" http://192.168.1.50')).toEqual(['<h1>NetLab site</h1>']);
    expect(sh.out('curl -s -H "Host: shop.lab.local" http://127.0.0.1')).toEqual(['<h1>Shop</h1>']);
    expect(sh.out('curl -s -H "Host: nobody.example" http://192.168.1.50').join('\n')).toContain('Welcome to nginx!');
    expect(sh.out('curl -s -o /dev/null -w "%{http_code}\\n" http://netlab.lab.local/missing.html')).toEqual(['404']);
    expect(sh.out('curl -sI http://netlab.lab.local')[0]).toBe('HTTP/1.1 200 OK');
    expect(sh.out('ss -tln').join('\n')).toContain('0.0.0.0:80');
    // The PC terminal prints a blank line after command output; the Linux shell does not.
    expect(sh.out('PC-A: curl -H "Host: shop.lab.local" http://192.168.1.50')).toEqual(['<h1>Shop</h1>', '']);
    expect(sh.check({ type: 'web-request', device: 'web1', host: '^shop\\.lab\\.local$', status: 200, server: 'shop.lab.local' })).toBe(true);
    expect(sh.check({ type: 'web-request', device: 'web1', host: 'nobody', server: '_' })).toBe(true);
    expect(sh.check({ type: 'web-request', device: 'web1', path: 'missing', status: 404 })).toBe(true);
    expect(sh.linux('web1').web.requests.filter((r) => r.host === 'shop.lab.local')).toHaveLength(2);
  });
});

describe('TLS', () => {
  const TLS = ['server {', '    listen 80;', '    server_name netlab.lab.local;', '    return 301 https://$host$request_uri;', '}', 'server {', '    listen 443 ssl;', '    server_name netlab.lab.local;', '    ssl_certificate /etc/ssl/certs/netlab.crt;', '    ssl_certificate_key /etc/ssl/private/netlab.key;', '    add_header Strict-Transport-Security "max-age=31536000" always;', '    root /var/www/netlab;', '    index index.html;', '}'];
  const MAKE_CERT = 'sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/netlab.key -out /etc/ssl/certs/netlab.crt -subj "/CN=netlab.lab.local"';

  it('creates and inspects self-signed certificates with openssl', () => {
    const sh = shell(site());
    expect(sh.out('openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout k.pem -out c.pem')[0]).toMatch(/You are about to be asked/);
    sh.run(MAKE_CERT);
    expect(sh.out('sudo stat -c "%a %U" /etc/ssl/private/netlab.key')).toEqual(['600 root']);
    expect(sh.out('sudo openssl x509 -in /etc/ssl/certs/netlab.crt -noout -subject -dates')).toEqual(['subject=CN=netlab.lab.local', 'notBefore=Sep 11 09:00:00 2026 GMT', 'notAfter=Sep 11 09:00:00 2027 GMT']);
    expect(sh.out('sudo head -1 /etc/ssl/certs/netlab.crt')).toEqual(['-----BEGIN CERTIFICATE-----']);
    expect(parseCertificate(makeCertificate('/CN=x', 30))?.days).toBe(30);
  });

  it('requires a certificate for an ssl listener and serves HTTPS, redirects and HSTS', () => {
    const sh = shell(site({ nginxActive: true }));
    sh.run(...heredoc('/etc/nginx/conf.d/netlab.conf', ...TLS));
    expect(sh.out('sudo nginx -t')[0]).toMatch(/cannot load certificate "\/etc\/ssl\/certs\/netlab\.crt"/);
    sh.run(MAKE_CERT, 'sudo systemctl reload nginx');
    expect(sh.out('curl -sI http://netlab.lab.local')[0]).toBe('HTTP/1.1 301 Moved Permanently');
    expect(sh.out('curl -sI http://netlab.lab.local').join('\n')).toContain('Location: https://netlab.lab.local/');
    expect(sh.out('curl -s https://netlab.lab.local')[0]).toBe('curl: (60) SSL certificate problem: self-signed certificate');
    expect(sh.out('curl -sk https://netlab.lab.local')).toEqual(['<h1>NetLab site</h1>']);
    const followed = sh.out('curl -skLi http://netlab.lab.local').join('\n');
    expect(followed).toContain('HTTP/1.1 301 Moved Permanently');
    expect(followed).toContain('HTTP/1.1 200 OK');
    expect(followed).toContain('Strict-Transport-Security: max-age=31536000');
    expect(sh.out('curl -s http://netlab.lab.local:443').join('\n')).toContain('The plain HTTP request was sent to HTTPS port');
    expect(sh.out('curl -sk https://192.168.2.50:8080')[0]).toMatch(/\(35\) OpenSSL/);
    expect(sh.out('ss -tln').join('\n')).toContain('0.0.0.0:443');
    expect(sh.check({ type: 'web-request', device: 'web1', scheme: 'https', status: 200 })).toBe(true);
    expect(sh.check({ type: 'web-request', device: 'web1', scheme: 'http', status: 301 })).toBe(true);
    // The rejected certificate fails during the handshake, so that attempt never reaches the server.
    expect(sh.linux('web1').web.requests.filter((r) => r.scheme === 'https')).toHaveLength(2);
  });
});

describe('reverse proxy and load balancing', () => {
  const LB = ['upstream backend {', '    server app1:8080;', '    server 192.168.3.50:8080;', '}', 'server {', '    listen 80;', '    server_name netlab.lab.local;', '    root /var/www/netlab;', '    location /app/ {', '        proxy_pass http://backend/;', '        proxy_set_header Host $host;', '    }', '}'];

  it('proxies to a single backend and rewrites the path', () => {
    const sh = shell(site({ nginxActive: true, conf: ['server {', '    listen 80;', '    server_name netlab.lab.local;', '    root /var/www/netlab;', '    location /app/ {', '        proxy_pass http://192.168.2.50:8080/;', '    }', '}'].join('\n') }));
    expect(sh.out('curl -s http://192.168.2.50:8080')).toEqual(['Hello from app1']);
    expect(sh.out('curl -s http://netlab.lab.local/app/')).toEqual(['Hello from app1']);
    expect(sh.out('curl -s http://netlab.lab.local/')).toEqual(['<h1>NetLab site</h1>']);
    expect(sh.out('PC-A: curl -H "Host: netlab.lab.local" http://192.168.1.50/app/')).toEqual(['Hello from app1', '']);
    expect(sh.check({ type: 'web-request', device: 'web1', path: '^/app/', status: 200, backend: 'app1' })).toBe(true);
    expect(sh.check({ type: 'web-request', device: 'app1', server: 'app', status: 200 })).toBe(true);
  });

  it('round-robins across an upstream, skips a dead backend, and answers 502 when none is left', () => {
    const sh = shell(site({ nginxActive: true, conf: LB.join('\n') }));
    expect(sh.out('for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done')).toEqual(['Hello from app1', 'Hello from app2', 'Hello from app1', 'Hello from app2']);
    sh.run('app2: sudo systemctl stop app');
    expect(sh.out('curl http://192.168.3.50:8080')[0]).toBe('curl: (7) Failed to connect to 192.168.3.50 port 8080 after 2 ms: Connection refused');
    expect(sh.out('for i in 1 2 3; do curl -s http://netlab.lab.local/app/; done')).toEqual(['Hello from app1', 'Hello from app1', 'Hello from app1']);
    sh.run('app1: sudo systemctl stop app');
    expect(sh.out('curl -s -o /dev/null -w "%{http_code}\\n" http://netlab.lab.local/app/')).toEqual(['502']);
    sh.run('app1: sudo systemctl start app', 'app2: sudo systemctl start app', 'for i in 1 2; do curl -s http://netlab.lab.local/app/; done');
    expect(sh.check({ type: 'web-request', device: 'web1', backend: 'app2', status: 200 })).toBe(true);
    expect(sh.check({ type: 'service', device: 'app2', name: 'app', active: true })).toBe(true);
  });

  it('rejects an unknown upstream host and honours weight, backup and least_conn', () => {
    const sh = shell(site({ nginxActive: true }));
    sh.run(...heredoc('/etc/nginx/conf.d/x.conf', 'server {', '    listen 80;', '    location / { proxy_pass http://nowhere; }', '}'));
    expect(sh.out('sudo nginx -t')[0]).toBe('nginx: [emerg] host not found in upstream "nowhere" in /etc/nginx/conf.d/x.conf:3');
    sh.run(...heredoc('/etc/nginx/conf.d/x.conf', 'upstream backend {', '    least_conn;', '    server app1:8080 weight=2;', '    server app2:8080 backup;', '}', 'server {', '    listen 80;', '    server_name lb.lab.local;', '    location / { proxy_pass http://backend; }', '}'));
    expect(sh.out('sudo nginx -t')[1]).toBe('nginx: configuration file /etc/nginx/nginx.conf test is successful');
    sh.run('sudo systemctl reload nginx');
    // A Host nginx does not know still lands on the default server, not on the proxy.
    expect(sh.out('curl -s http://192.168.1.50/').join('\n')).toContain('Welcome to nginx!');
    expect(sh.out('for i in 1 2 3; do curl -s http://lb.lab.local/; done')).toEqual(['Hello from app1', 'Hello from app1', 'Hello from app1']);
    // The backup server takes over only once every primary is gone.
    sh.run('app1: sudo systemctl stop app');
    expect(sh.out('curl -s http://lb.lab.local/')).toEqual(['Hello from app2']);
  });
});
