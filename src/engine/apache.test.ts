import { describe, expect, it } from 'vitest';
import { evaluateCheck, type Check } from './grader';
import { buildNetwork, createRouter, createSwitch, executeHost, type NetworkState } from './index';

/** web1 (apache2) and PC-A on one LAN; app1 and app2 run the demo application on 8080 behind the routers. */
function site(opts: { apacheActive?: boolean; withNginx?: boolean; conf?: string; modules?: string[] } = {}): NetworkState {
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
  const app = (hostname: string) => ({ hostname, packages: ['netlab-app'], services: { app: { active: true, enabled: true } } });
  return buildNetwork({
    primary: 'web1',
    devices: [r1, r2, createSwitch({ hostname: 'SW1', ports: 4 })],
    hosts: [
      {
        id: 'web1',
        ip: '192.168.1.50',
        mask: '255.255.255.0',
        gateway: '192.168.1.1',
        linux: {
          hostname: 'web1',
          packages: ['apache2', 'openssl', ...(opts.withNginx ? ['nginx'] : [])],
          services: { apache2: { active: Boolean(opts.apacheActive), enabled: false }, ...(opts.withNginx ? { nginx: { active: true, enabled: true } } : {}) },
          files: { '/var/www/netlab/index.html': '<h1>NetLab site</h1>\n', '/etc/hosts': '127.0.0.1 localhost\n127.0.0.1 netlab.lab.local shop.lab.local\n192.168.2.50 app1\n192.168.3.50 app2\n', ...(opts.conf ? { '/etc/apache2/sites-enabled/netlab.conf': opts.conf } : {}) },
        },
      },
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'app1', ip: '192.168.2.50', mask: '255.255.255.0', gateway: '192.168.2.1', linux: app('app1') },
      { id: 'app2', ip: '192.168.3.50', mask: '255.255.255.0', gateway: '192.168.3.1', linux: app('app2') },
    ],
    links: [['web1', 'SW1:g0/1'], ['PC-A', 'SW1:g0/2'], ['SW1:g0/4', 'R1:g0/0'], ['app1', 'R1:g0/1'], ['R1:g0/2', 'R2:g0/1'], ['app2', 'R2:g0/0']],
  });
}

function shell(initial: NetworkState) {
  let net = initial;
  const step = (raw: string): string[] => {
    const m = raw.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    const node = m && net.hosts[m[1]] ? m[1] : 'web1';
    const r = executeHost(net, node, m && net.hosts[m[1]] ? m[2] : raw);
    net = r.network;
    return r.output;
  };
  return {
    run: (...lines: string[]) => lines.map(step).pop() ?? [],
    out: (line: string) => step(line),
    check: (c: Check) => evaluateCheck(c, net),
    linux: (id: string) => net.hosts[id].linux!,
  };
}

const tee = (file: string, ...lines: string[]) => [`sudo tee ${file} << 'EOF'`, ...lines, 'EOF'];
const VHOST = ['<VirtualHost *:80>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '</VirtualHost>'];

describe('apache2 out of the box', () => {
  it('ships the Debian layout, passes configtest and serves the default site', () => {
    const sh = shell(site({ apacheActive: true }));
    expect(sh.out('ls /etc/apache2')).toEqual(['apache2.conf  conf-available  conf-enabled  envvars  mods-available  mods-enabled  ports.conf  sites-available  sites-enabled']);
    expect(sh.out('ls /etc/apache2/sites-enabled')).toEqual(['000-default.conf']);
    expect(sh.out('sudo apache2ctl configtest').pop()).toBe('Syntax OK');
    expect(sh.out('apache2ctl -M').join('\n')).toContain(' dir_module (shared)');
    expect(sh.out('apache2ctl -M').join('\n')).not.toContain(' ssl_module');
    expect(sh.out('curl -s http://192.168.1.50').join('\n')).toContain('Apache2 Ubuntu Default Page');
    expect(sh.out('ss -tln').join('\n')).toContain('0.0.0.0:80');
    expect(sh.check({ type: 'web-request', device: 'web1', status: 200, engine: 'apache' })).toBe(true);
  });

  it('enables a site only once a2ensite and a reload have run', () => {
    const sh = shell(site({ apacheActive: true }));
    sh.run(...tee('/etc/apache2/sites-available/netlab.conf', ...VHOST));
    // Written but not enabled: the default site still answers.
    expect(sh.out('curl -s http://netlab.lab.local').join('\n')).toContain('Apache2 Ubuntu Default Page');
    expect(sh.out('a2ensite netlab')[0]).toMatch(/Permission denied/);
    expect(sh.out('sudo a2ensite netlab')).toEqual(['Enabling site netlab.', 'To activate the new configuration, you need to run:', '  systemctl reload apache2']);
    expect(sh.out('ls /etc/apache2/sites-enabled')).toEqual(['000-default.conf  netlab.conf']);
    // Enabled on disk, but Apache still serves what it loaded at start.
    expect(sh.out('curl -s http://netlab.lab.local').join('\n')).toContain('Apache2 Ubuntu Default Page');
    sh.run('sudo systemctl reload apache2');
    expect(sh.out('curl -s http://netlab.lab.local')).toEqual(['<h1>NetLab site</h1>']);
    // An unknown name falls back to the first virtual host on the port.
    expect(sh.out('curl -s -H "Host: nobody.example" http://192.168.1.50').join('\n')).toContain('Apache2 Ubuntu Default Page');
    expect(sh.out('sudo apache2ctl -S').join('\n')).toContain('netlab.lab.local (/etc/apache2/sites-enabled/netlab.conf:1)');
    sh.run('sudo a2dissite netlab', 'sudo systemctl reload apache2');
    expect(sh.out('curl -s http://netlab.lab.local').join('\n')).toContain('Apache2 Ubuntu Default Page');
  });
});

describe('apache2 configuration errors', () => {
  it('names the file and line for a misspelled directive and an unclosed section', () => {
    const sh = shell(site({ apacheActive: true }));
    sh.run(...tee('/etc/apache2/sites-available/bad.conf', '<VirtualHost *:80>', '    ServerName x', '    DocumnetRoot /var/www/netlab', '</VirtualHost>'), 'sudo a2ensite bad');
    const bad = sh.out('sudo apache2ctl configtest');
    expect(bad[1]).toBe('AH00526: Syntax error on line 3 of /etc/apache2/sites-enabled/bad.conf:');
    expect(bad[2]).toBe("Invalid command 'DocumnetRoot', perhaps misspelled or defined by a module not included in the server configuration");
    expect(bad.pop()).toBe('The Apache error log may have more information.');
    sh.run(...tee('/etc/apache2/sites-available/bad.conf', '<VirtualHost *:80>', '    ServerName x'));
    expect(sh.out('sudo apache2ctl configtest')[2]).toBe('<VirtualHost> was not closed.');
    // A broken configuration keeps the running server on its old one.
    expect(sh.out('curl -s http://192.168.1.50').join('\n')).toContain('Apache2 Ubuntu Default Page');
    expect(sh.out('sudo systemctl restart apache2')[0]).toBe('Job for apache2.service failed because the control process exited with error code.');
    expect(sh.linux('web1').services.apache2.active).toBe(false);
    expect(sh.out('systemctl status apache2').join('\n')).toContain('<VirtualHost> was not closed.');
    expect(sh.check({ type: 'apache-config', device: 'web1', valid: false })).toBe(true);
    sh.run('sudo a2dissite bad', 'sudo systemctl start apache2');
    expect(sh.linux('web1').services.apache2.active).toBe(true);
    expect(sh.check({ type: 'apache-config', device: 'web1', valid: true })).toBe(true);
  });

  it('refuses a directive whose module is not enabled, and accepts it once a2enmod has run', () => {
    const sh = shell(site({ apacheActive: true }));
    sh.run(
      ...tee('/etc/apache2/sites-available/tls.conf', '<VirtualHost *:443>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '    SSLEngine on', '    SSLCertificateFile /etc/ssl/certs/netlab.crt', '    SSLCertificateKeyFile /etc/ssl/private/netlab.key', '</VirtualHost>'),
      'sudo a2ensite tls',
    );
    expect(sh.out('sudo apache2ctl configtest')[2]).toBe("Invalid command 'SSLEngine', perhaps misspelled or defined by a module not included in the server configuration");
    expect(sh.out('sudo a2enmod ssl')).toEqual(['Enabling module ssl.', 'To activate the new configuration, you need to run:', '  systemctl restart apache2']);
    // The module is enabled, but the certificate does not exist yet.
    expect(sh.out('sudo apache2ctl configtest')[2]).toMatch(/cannot load certificate "\/etc\/ssl\/certs\/netlab\.crt"/);
    sh.run('sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/netlab.key -out /etc/ssl/certs/netlab.crt -subj "/CN=netlab.lab.local"');
    expect(sh.out('sudo apache2ctl configtest').pop()).toBe('Syntax OK');
    sh.run('sudo systemctl restart apache2');
    // Enabling mod_ssl is what makes ports.conf listen on 443.
    expect(sh.out('ss -tln').join('\n')).toContain('0.0.0.0:443');
    expect(sh.out('curl -s https://netlab.lab.local')[0]).toBe('curl: (60) SSL certificate problem: self-signed certificate');
    expect(sh.out('curl -sk https://netlab.lab.local')).toEqual(['<h1>NetLab site</h1>']);
    expect(sh.check({ type: 'web-request', device: 'web1', scheme: 'https', status: 200, engine: 'apache' })).toBe(true);
    expect(sh.check({ type: 'apache-module', device: 'web1', name: 'ssl' })).toBe(true);
    expect(sh.check({ type: 'apache-module', device: 'web1', name: 'rewrite', enabled: false })).toBe(true);
    sh.run('sudo a2dismod ssl', 'sudo systemctl restart apache2');
    expect(sh.out('ss -tln').join('\n')).not.toContain('0.0.0.0:443');
  });
});

describe('apache2 redirects, proxying and load balancing', () => {
  it('redirects to https and sets a header once mod_headers is enabled', () => {
    const sh = shell(site({ apacheActive: true }));
    sh.run(
      'sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/netlab.key -out /etc/ssl/certs/netlab.crt -subj "/CN=netlab.lab.local"',
      'sudo a2enmod ssl',
      ...tee(
        '/etc/apache2/sites-available/netlab.conf',
        '<VirtualHost *:80>',
        '    ServerName netlab.lab.local',
        '    Redirect permanent / https://netlab.lab.local/',
        '</VirtualHost>',
        '<VirtualHost *:443>',
        '    ServerName netlab.lab.local',
        '    DocumentRoot /var/www/netlab',
        '    SSLEngine on',
        '    SSLCertificateFile /etc/ssl/certs/netlab.crt',
        '    SSLCertificateKeyFile /etc/ssl/private/netlab.key',
        '    Header always set Strict-Transport-Security "max-age=31536000"',
        '</VirtualHost>',
      ),
      'sudo a2ensite netlab',
    );
    expect(sh.out('sudo apache2ctl configtest')[2]).toBe("Invalid command 'Header', perhaps misspelled or defined by a module not included in the server configuration");
    sh.run('sudo a2enmod headers', 'sudo systemctl restart apache2');
    expect(sh.out('sudo apache2ctl configtest').pop()).toBe('Syntax OK');
    expect(sh.out('curl -sI http://netlab.lab.local')[0]).toBe('HTTP/1.1 301 Moved Permanently');
    const followed = sh.out('curl -skLi http://netlab.lab.local').join('\n');
    expect(followed).toContain('Location: https://netlab.lab.local/');
    expect(followed).toContain('Strict-Transport-Security: max-age=31536000');
    expect(sh.check({ type: 'web-request', device: 'web1', scheme: 'http', status: 301, engine: 'apache' })).toBe(true);
  });

  it('needs both proxy and proxy_http, then reverse proxies to the application', () => {
    const sh = shell(site({ apacheActive: true }));
    sh.run(...tee('/etc/apache2/sites-available/netlab.conf', '<VirtualHost *:80>', '    ServerName netlab.lab.local', '    DocumentRoot /var/www/netlab', '    ProxyPass /app/ http://192.168.2.50:8080/', '    ProxyPassReverse /app/ http://192.168.2.50:8080/', '</VirtualHost>'), 'sudo a2ensite netlab');
    expect(sh.out('sudo apache2ctl configtest')[2]).toBe("Invalid command 'ProxyPass', perhaps misspelled or defined by a module not included in the server configuration");
    sh.run('sudo a2enmod proxy', 'sudo systemctl restart apache2');
    expect(sh.out('sudo apache2ctl configtest').pop()).toBe('Syntax OK');
    // mod_proxy alone has no protocol handler: Apache answers 500 until proxy_http is loaded.
    expect(sh.out('curl -s -o /dev/null -w "%{http_code}\\n" http://netlab.lab.local/app/')).toEqual(['500']);
    sh.run('sudo a2enmod proxy_http', 'sudo systemctl restart apache2');
    expect(sh.out('curl -s http://netlab.lab.local/app/')).toEqual(['Hello from app1']);
    expect(sh.out('curl -s http://netlab.lab.local/')).toEqual(['<h1>NetLab site</h1>']);
    expect(sh.check({ type: 'web-request', device: 'web1', path: '^/app/', status: 200, backend: 'app1', engine: 'apache' })).toBe(true);
  });

  it('balances across BalancerMembers and reports a missing lbmethod', () => {
    const sh = shell(site({ apacheActive: true }));
    sh.run(
      'sudo a2enmod proxy proxy_http proxy_balancer',
      ...tee(
        '/etc/apache2/sites-available/netlab.conf',
        '<VirtualHost *:80>',
        '    ServerName netlab.lab.local',
        '    DocumentRoot /var/www/netlab',
        '    <Proxy balancer://cluster>',
        '        BalancerMember http://192.168.2.50:8080',
        '        BalancerMember http://192.168.3.50:8080',
        '    </Proxy>',
        '    ProxyPass /app/ balancer://cluster/',
        '</VirtualHost>',
      ),
      'sudo a2ensite netlab',
    );
    expect(sh.out('sudo apache2ctl configtest')[1]).toMatch(/^AH01179: Cannot find 'byrequests' lb method/);
    sh.run('sudo a2enmod lbmethod_byrequests', 'sudo systemctl restart apache2');
    expect(sh.out('sudo apache2ctl configtest').pop()).toBe('Syntax OK');
    expect(sh.out('for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done')).toEqual(['Hello from app1', 'Hello from app2', 'Hello from app1', 'Hello from app2']);
    sh.run('app2: sudo systemctl stop app');
    expect(sh.out('for i in 1 2 3; do curl -s http://netlab.lab.local/app/; done')).toEqual(['Hello from app1', 'Hello from app1', 'Hello from app1']);
    expect(sh.check({ type: 'web-request', device: 'web1', backend: 'app2', engine: 'apache' })).toBe(true);
  });
});

describe('two servers on one host', () => {
  it('refuses to bind a port nginx already holds, and shares the host once the ports differ', () => {
    const sh = shell(site({ withNginx: true }));
    // Both packages ship an index; apache2's /var/www/html/index.html wins nginx's index list,
    // so check which server answered rather than the page it returned.
    sh.run('curl -s http://192.168.1.50');
    expect(sh.check({ type: 'web-request', device: 'web1', engine: 'nginx', status: 200 })).toBe(true);
    expect(sh.out('sudo systemctl start apache2')[0]).toBe('Job for apache2.service failed because the control process exited with error code.');
    expect(sh.out('systemctl status apache2').join('\n')).toContain('(98)Address already in use: AH00072: make_sock: could not bind to address 0.0.0.0:80');
    expect(sh.linux('web1').services.apache2.active).toBe(false);
    // Move Apache to 8081 and both servers run side by side.
    sh.run(...tee('/etc/apache2/ports.conf', 'Listen 8081'), ...tee('/etc/apache2/sites-available/000-default.conf', '<VirtualHost *:8081>', '    DocumentRoot /var/www/netlab', '</VirtualHost>'), 'sudo systemctl start apache2');
    expect(sh.linux('web1').services.apache2.active).toBe(true);
    expect(sh.out('curl -s http://192.168.1.50:8081')).toEqual(['<h1>NetLab site</h1>']);
    expect(sh.out('ss -tln').join('\n')).toContain('0.0.0.0:8081');
    expect(sh.check({ type: 'web-request', device: 'web1', engine: 'nginx' })).toBe(true);
    expect(sh.check({ type: 'web-request', device: 'web1', engine: 'apache' })).toBe(true);
  });
});
