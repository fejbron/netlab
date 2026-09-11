import { APACHE_MODULES, buildNetwork, createRouter, createSwitch, makeCertificate, makePrivateKey, type LinuxSpec, type NetworkState } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'linux-apache';
const W = 'web1';

const HOSTS_FILE = '127.0.0.1 localhost\n127.0.1.1 web1\n127.0.0.1 netlab.lab.local www.lab.local\n192.168.2.50 app1\n192.168.2.51 app2\n\n::1 ip6-localhost ip6-loopback\n';
const SITE_HTML = '<!DOCTYPE html>\n<html>\n<head><title>NetLab</title></head>\n<body><h1>NetLab site</h1></body>\n</html>\n';

/** A virtual host with a misspelled directive and a missing closing tag. */
const VHOST_BROKEN = `<VirtualHost *:80>
    ServerName netlab.lab.local
    DocumnetRoot /var/www/netlab
    DirectoryIndex index.html
`;

const VHOST_80 = `<VirtualHost *:80>
    ServerName netlab.lab.local
    DocumentRoot /var/www/netlab
</VirtualHost>
`;

const VHOST_TLS = `<VirtualHost *:80>
    ServerName netlab.lab.local
    DocumentRoot /var/www/netlab
</VirtualHost>

<VirtualHost *:443>
    ServerName netlab.lab.local
    DocumentRoot /var/www/netlab
    SSLEngine on
    SSLCertificateFile /etc/ssl/certs/netlab.crt
    SSLCertificateKeyFile /etc/ssl/private/netlab.key
</VirtualHost>
`;

const VHOST_PROXY = `<VirtualHost *:80>
    ServerName netlab.lab.local
    DocumentRoot /var/www/netlab

    ProxyPass /app/ http://192.168.2.50:8080/
    ProxyPassReverse /app/ http://192.168.2.50:8080/
</VirtualHost>
`;

interface SiteOpts {
  /** apache2 is not installed yet (the first lab installs it). */
  notInstalled?: boolean;
  /** apache2 is running at the start. */
  running?: boolean;
  /** Contents of /etc/apache2/sites-available/netlab.conf, enabled unless `notEnabled`. */
  conf?: string;
  notEnabled?: boolean;
  /** Modules to enable before the lab starts. */
  modules?: string[];
  /** The certificate and key for netlab.lab.local already exist. */
  certs?: boolean;
  /** nginx is installed and holding port 80. */
  nginx?: boolean;
}

/**
 * web1 192.168.1.50 (Apache) and PC-A on SW1 behind R1; app1 192.168.2.50 and app2
 * 192.168.2.51 run the demo application on 8080 on the far side of R2.
 */
function apacheSite(opts: SiteOpts = {}): NetworkState {
  const r1 = createRouter({
    hostname: 'R1',
    interfaces: { 'g0/0': { description: 'Site 1 LAN', ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R2', ipAddress: '10.0.0.1', subnetMask: '255.255.255.252', shutdown: false } },
    staticRoutes: [{ destination: '192.168.2.0', mask: '255.255.255.0', nextHop: '10.0.0.2' }],
  });
  const r2 = createRouter({
    hostname: 'R2',
    interfaces: { 'g0/0': { description: 'Site 2 LAN', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0', shutdown: false }, 'g0/1': { description: 'Link to R1', ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } },
    staticRoutes: [{ destination: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.0.1' }],
  });
  const sw1 = createSwitch({ hostname: 'SW1', ports: 8, interfaces: { 'g0/1': { description: 'web1' }, 'g0/2': { description: 'PC-A' }, 'g0/8': { description: 'Uplink to R1' } } });
  const sw2 = createSwitch({ hostname: 'SW2', ports: 8, interfaces: { 'g0/1': { description: 'app1' }, 'g0/2': { description: 'app2' }, 'g0/8': { description: 'Uplink to R2' } } });
  /** a2ensite and a2enmod are symlinks from the -enabled directory into the -available one. */
  const enable = (dir: string, file: string) => [`/etc/apache2/${dir}-enabled/${file}`, { link: `/etc/apache2/${dir}-available/${file}` }] as const;
  const web: LinuxSpec = {
    hostname: 'web1',
    packages: [...(opts.notInstalled ? [] : ['apache2']), 'openssl', ...(opts.nginx ? ['nginx'] : [])],
    services: {
      ...(opts.notInstalled ? {} : { apache2: { active: Boolean(opts.running), enabled: Boolean(opts.running) } }),
      ...(opts.nginx ? { nginx: { active: true, enabled: true } } : {}),
    },
    files: {
      '/var/www/netlab/index.html': SITE_HTML,
      '/etc/hosts': HOSTS_FILE,
      ...(opts.conf ? { '/etc/apache2/sites-available/netlab.conf': opts.conf } : {}),
      ...(opts.conf && !opts.notEnabled ? Object.fromEntries([enable('sites', 'netlab.conf')]) : {}),
      ...Object.fromEntries((opts.modules ?? []).flatMap((m) => [enable('mods', `${m}.load`), ...(APACHE_MODULES[m]?.conf ? [enable('mods', `${m}.conf`)] : [])])),
      ...(opts.certs ? { '/etc/ssl/certs/netlab.crt': makeCertificate('/CN=netlab.lab.local', 365), '/etc/ssl/private/netlab.key': { content: makePrivateKey('/CN=netlab.lab.local'), mode: 0o600 } } : {}),
    },
  };
  const app = (hostname: string): LinuxSpec => ({ hostname, packages: ['netlab-app'], services: { app: { active: true, enabled: true } } });
  return buildNetwork({
    primary: W,
    devices: [r1, r2, sw1, sw2],
    hosts: [
      { id: 'web1', ip: '192.168.1.50', mask: '255.255.255.0', gateway: '192.168.1.1', linux: web },
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'app1', ip: '192.168.2.50', mask: '255.255.255.0', gateway: '192.168.2.1', linux: app('app1') },
      { id: 'app2', ip: '192.168.2.51', mask: '255.255.255.0', gateway: '192.168.2.1', linux: app('app2') },
    ],
    links: [['web1', 'SW1:g0/1'], ['PC-A', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'SW2:g0/8'], ['app1', 'SW2:g0/1'], ['app2', 'SW2:g0/2']],
  });
}

const SITE = '/etc/apache2/sites-available/netlab.conf';

export const linuxApacheLabs: Lab[] = [
  {
    id: 'lx-34-install-apache',
    moduleId: MODULE,
    order: 1,
    title: 'Install and Explore Apache',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Install apache2, find your way around its Debian layout, and see which modules are loaded.',
    scenario:
      'web1 has no web server yet. Install apache2 with apt; the package starts and enables the service for you.\n\nExplore what it laid down: /etc/apache2/apache2.conf is the main file, ports.conf says which ports to listen on, and the real configuration lives in sites-available with symlinks in sites-enabled. List /etc/apache2 and /etc/apache2/sites-enabled, check the syntax with sudo apache2ctl configtest, and list the loaded modules with apache2ctl -M. Finish by fetching the default page with curl http://192.168.1.50 from web1 and from PC-A.',
    concepts: ['apt install apache2', 'apache2.conf, ports.conf, sites-available and sites-enabled', 'apache2ctl configtest and -M', 'The Ubuntu default page'],
    hints: [
      'sudo apt install -y apache2 installs it and starts the service.',
      'ls /etc/apache2 then ls -l /etc/apache2/sites-enabled shows 000-default.conf is a symlink into sites-available.',
      'sudo apache2ctl configtest prints Syntax OK; apache2ctl -M lists the loaded modules.',
    ],
    createState: () => apacheSite({ notInstalled: true }),
    objectives: [
      { id: 'install', label: 'Install apache2', checks: [{ type: 'package', device: W, name: 'apache2' }, { type: 'service', device: W, name: 'apache2', active: true }] },
      { id: 'explore', label: 'Explore the layout', checks: [{ type: 'command', device: W, pattern: '^ls\\b.*/etc/apache2$' }, { type: 'command', device: W, pattern: '^ls\\b.*sites-enabled' }] },
      { id: 'check', label: 'Test the configuration and list the modules', checks: [{ type: 'command', device: W, pattern: '^(sudo )?apache2ctl configtest$' }, { type: 'command', device: W, pattern: '^(sudo )?apache2ctl -M$' }] },
      { id: 'serve', label: 'The default page answers', checks: [{ type: 'web-request', device: W, status: 200, engine: 'apache' }, { type: 'command', device: 'PC-A', pattern: '^curl\\b.*192\\.168\\.1\\.50', label: 'Fetched the page from PC-A' }] },
    ],
  },
  {
    id: 'lx-35-apache-virtual-host',
    moduleId: MODULE,
    order: 2,
    title: 'Your First Virtual Host',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Write a VirtualHost, enable it with a2ensite, and learn why a reload is what makes it live.',
    scenario:
      'Serve netlab.lab.local from /var/www/netlab, which already holds an index.html.\n\nWrite /etc/apache2/sites-available/netlab.conf with a <VirtualHost *:80> block containing ServerName netlab.lab.local and DocumentRoot /var/www/netlab. Enable it with sudo a2ensite netlab and notice the message telling you to reload. Before you reload, fetch http://netlab.lab.local and see the Ubuntu default page: Apache is still serving the configuration it loaded at start. Reload, fetch again, and now your site answers.\n\nFinally fetch with an unknown name (curl -H "Host: nobody.example" http://192.168.1.50) and see it land on the first virtual host for the port, which is still 000-default.',
    concepts: ['<VirtualHost *:80>, ServerName, DocumentRoot', 'a2ensite and the sites-enabled symlink', 'systemctl reload apache2', 'The first virtual host on a port is its default'],
    hints: [
      "sudo tee /etc/apache2/sites-available/netlab.conf << 'EOF' … <VirtualHost *:80> … EOF",
      'sudo a2ensite netlab creates the symlink; ls -l /etc/apache2/sites-enabled shows it.',
      'sudo apache2ctl configtest, then sudo systemctl reload apache2, then curl http://netlab.lab.local.',
    ],
    createState: () => apacheSite({ running: true }),
    objectives: [
      { id: 'conf', label: 'Write the virtual host', checks: [{ type: 'file', device: W, path: SITE, contains: '<VirtualHost \\*:80>' }, { type: 'file', device: W, path: SITE, contains: 'ServerName\\s+netlab\\.lab\\.local' }, { type: 'file', device: W, path: SITE, contains: 'DocumentRoot\\s+/var/www/netlab' }] },
      { id: 'enable', label: 'Enable it with a2ensite', checks: [{ type: 'command', device: W, pattern: '^sudo a2ensite\\b' }, { type: 'apache-site', device: W, name: 'netlab' }, { type: 'apache-config', device: W, valid: true }] },
      { id: 'reload', label: 'Reload Apache', checks: [{ type: 'command', device: W, pattern: '^sudo systemctl reload apache2$' }] },
      { id: 'serve', label: 'The site answers to its name', checks: [{ type: 'web-request', device: W, host: '^netlab\\.lab\\.local$', status: 200, server: 'netlab.lab.local', engine: 'apache' }] },
      { id: 'default', label: 'An unknown name lands on the default virtual host', checks: [{ type: 'web-request', device: W, host: 'nobody', status: 200, engine: 'apache' }] },
    ],
  },
  {
    id: 'lx-36-troubleshoot-apache',
    moduleId: MODULE,
    order: 3,
    title: "Troubleshoot: Apache Won't Start",
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Two faults stop Apache from starting. Let configtest name each one, fix them, and bring the site up.',
    scenario:
      'Someone edited netlab.conf and Apache is down. Try sudo systemctl start apache2 and read the failure, then ask Apache what is wrong with sudo apache2ctl configtest.\n\nIt reports one problem at a time, with the file and the line. Fix that one, run configtest again, fix the next, and keep going until it says Syntax OK. Then start Apache and prove the site answers at http://netlab.lab.local.',
    concepts: ['apache2ctl configtest names file and line', 'Unclosed sections', "Invalid command: a typo or a module that is not enabled", 'Fix, test, start'],
    hints: [
      'systemctl status apache2 and sudo apache2ctl configtest both show the reason.',
      'The first complaint is that <VirtualHost> was not closed: the file needs a </VirtualHost> line at the end.',
      "Then it reports Invalid command 'DocumnetRoot': that is a misspelling of DocumentRoot. sudo sed -i 's/DocumnetRoot/DocumentRoot/' /etc/apache2/sites-available/netlab.conf",
    ],
    createState: () => apacheSite({ conf: VHOST_BROKEN }),
    objectives: [
      { id: 'diagnose', label: 'Let Apache explain the failure', checks: [{ type: 'command', device: W, pattern: '^(sudo )?apache2ctl (configtest|-t)$' }, { type: 'shell-output', device: W, pattern: 'AH00526: Syntax error', label: 'Saw a configtest syntax error' }] },
      { id: 'closed', label: 'Close the VirtualHost block', checks: [{ type: 'file', device: W, path: SITE, contains: '</VirtualHost>' }] },
      { id: 'spelling', label: 'Correct the misspelled directive', checks: [{ type: 'file', device: W, path: SITE, contains: 'DocumentRoot\\s+/var/www/netlab' }, { type: 'file', device: W, path: SITE, notContains: 'DocumnetRoot' }, { type: 'apache-config', device: W, valid: true }] },
      { id: 'up', label: 'Apache runs again and serves the site', checks: [{ type: 'service', device: W, name: 'apache2', active: true }, { type: 'web-request', device: W, host: '^netlab\\.lab\\.local$', status: 200, engine: 'apache' }] },
    ],
  },
  {
    id: 'lx-37-apache-tls',
    moduleId: MODULE,
    order: 4,
    title: 'Enable mod_ssl and Serve HTTPS',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Discover that SSLEngine needs its module, enable it with a2enmod, and serve the site over TLS.',
    scenario:
      'Add a TLS virtual host. Append a <VirtualHost *:443> block to netlab.conf with the same ServerName and DocumentRoot plus SSLEngine on, SSLCertificateFile /etc/ssl/certs/netlab.crt and SSLCertificateKeyFile /etc/ssl/private/netlab.key.\n\nRun configtest: Apache says Invalid command SSLEngine, because a directive only exists when its module is loaded. Enable it with sudo a2enmod ssl. Test again: now it complains that the certificate cannot be loaded, so create one with openssl (see the hints). Test once more, restart Apache, and confirm that enabling mod_ssl is also what made ports.conf listen on 443 (check with ss -tln). Fetch https://netlab.lab.local with and without -k.',
    concepts: ['a2enmod and Invalid command errors', 'SSLEngine, SSLCertificateFile, SSLCertificateKeyFile', 'ports.conf listens on 443 inside <IfModule ssl_module>', 'Self-signed certificates and curl -k'],
    hints: [
      'sudo a2enmod ssl, then sudo apache2ctl configtest again.',
      'sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/netlab.key -out /etc/ssl/certs/netlab.crt -subj "/CN=netlab.lab.local"',
      'sudo systemctl restart apache2, then ss -tln shows 0.0.0.0:443, and curl -k https://netlab.lab.local shows the page.',
    ],
    createState: () => apacheSite({ running: true, conf: VHOST_80 }),
    objectives: [
      { id: 'module', label: 'Enable mod_ssl', checks: [{ type: 'command', device: W, pattern: '^sudo a2enmod\\b.*\\bssl\\b' }, { type: 'apache-module', device: W, name: 'ssl' }] },
      { id: 'cert', label: 'Create the certificate and key', checks: [{ type: 'file', device: W, path: '/etc/ssl/certs/netlab.crt', contains: 'BEGIN CERTIFICATE' }, { type: 'file', device: W, path: '/etc/ssl/private/netlab.key', contains: 'PRIVATE KEY', mode: '600' }] },
      { id: 'vhost', label: 'Add the TLS virtual host', checks: [{ type: 'file', device: W, path: SITE, contains: '<VirtualHost \\*:443>' }, { type: 'file', device: W, path: SITE, contains: 'SSLCertificateKeyFile\\s+/etc/ssl/private/netlab\\.key' }, { type: 'apache-config', device: W, valid: true }] },
      { id: 'https', label: 'HTTPS answers', checks: [{ type: 'web-request', device: W, scheme: 'https', host: '^netlab\\.lab\\.local$', status: 200, engine: 'apache' }, { type: 'shell-output', device: W, pattern: '\\(60\\) SSL certificate problem', label: 'Saw curl reject the self-signed certificate without -k' }] },
    ],
  },
  {
    id: 'lx-38-apache-redirect-hsts',
    moduleId: MODULE,
    order: 5,
    title: 'Redirect to HTTPS and Set HSTS',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Turn the plain-HTTP virtual host into a permanent redirect and add a security header with mod_headers.',
    scenario:
      'netlab.lab.local already answers on both 80 and 443. Make the plain-HTTP virtual host redirect instead of serving: replace its DocumentRoot with\n\nRedirect permanent / https://netlab.lab.local/\n\nIn the TLS virtual host add\n\nHeader always set Strict-Transport-Security "max-age=31536000"\n\nRun configtest: Header belongs to mod_headers, so enable it with a2enmod. Test, restart, then check the redirect with curl -I http://netlab.lab.local and follow it with curl -kLi http://netlab.lab.local to see the header on the final response.',
    concepts: ['Redirect permanent (mod_alias)', 'a2enmod headers', 'Strict-Transport-Security', 'curl -I and curl -L'],
    hints: [
      'In the *:80 block: Redirect permanent / https://netlab.lab.local/',
      'In the *:443 block: Header always set Strict-Transport-Security "max-age=31536000"',
      'sudo a2enmod headers; sudo apache2ctl configtest; sudo systemctl restart apache2; curl -I http://netlab.lab.local',
    ],
    createState: () => apacheSite({ running: true, conf: VHOST_TLS, modules: ['ssl'], certs: true }),
    objectives: [
      { id: 'module', label: 'Enable mod_headers', checks: [{ type: 'apache-module', device: W, name: 'headers' }] },
      { id: 'conf', label: 'Redirect and header configured', checks: [{ type: 'file', device: W, path: SITE, contains: 'Redirect\\s+permanent\\s+/\\s+https://' }, { type: 'file', device: W, path: SITE, contains: 'Strict-Transport-Security' }, { type: 'apache-config', device: W, valid: true }] },
      { id: 'redirect', label: 'Plain HTTP is redirected', checks: [{ type: 'web-request', device: W, scheme: 'http', host: '^netlab\\.lab\\.local$', status: 301, engine: 'apache' }, { type: 'command', device: W, pattern: '^curl\\b.*-\\w*I', label: 'Checked the headers with curl -I' }] },
      { id: 'follow', label: 'Following the redirect reaches HTTPS', checks: [{ type: 'command', device: W, pattern: '^curl\\b.*-\\w*L' }, { type: 'web-request', device: W, scheme: 'https', status: 200, engine: 'apache' }] },
    ],
  },
  {
    id: 'lx-39-apache-reverse-proxy',
    moduleId: MODULE,
    order: 6,
    title: 'Reverse Proxy With mod_proxy',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Put Apache in front of an application server and learn why mod_proxy alone is not enough.',
    scenario:
      'app1 (192.168.2.50) runs the application on port 8080; check it directly with curl http://192.168.2.50:8080.\n\nIn the netlab.lab.local virtual host add:\n\nProxyPass /app/ http://192.168.2.50:8080/\nProxyPassReverse /app/ http://192.168.2.50:8080/\n\nconfigtest reports Invalid command ProxyPass until you enable mod_proxy. Enable it, restart, and fetch http://netlab.lab.local/app/: Apache answers 500, because mod_proxy knows how to proxy but not how to speak HTTP. Enable mod_proxy_http as well, restart, and the application answers through Apache.',
    concepts: ['ProxyPass and ProxyPassReverse', 'a2enmod proxy proxy_http', 'Why a 500 appears with only mod_proxy', 'Front end versus backend'],
    hints: [
      'sudo a2enmod proxy, then sudo apache2ctl configtest.',
      'After restarting, curl -i http://netlab.lab.local/app/ returns 500 Internal Server Error.',
      'sudo a2enmod proxy_http; sudo systemctl restart apache2; curl http://netlab.lab.local/app/',
    ],
    createState: () => apacheSite({ running: true, conf: VHOST_80 }),
    objectives: [
      { id: 'direct', label: 'See the backend directly', checks: [{ type: 'command', device: W, pattern: '^curl\\b.*192\\.168\\.2\\.50:8080' }] },
      { id: 'modules', label: 'Enable both proxy modules', checks: [{ type: 'apache-module', device: W, name: 'proxy' }, { type: 'apache-module', device: W, name: 'proxy_http' }] },
      { id: 'conf', label: 'ProxyPass configured', checks: [{ type: 'file', device: W, path: SITE, contains: 'ProxyPass\\s+/app/\\s+http://192\\.168\\.2\\.50:8080' }, { type: 'apache-config', device: W, valid: true }] },
      { id: 'proxied', label: 'The application answers through Apache', checks: [{ type: 'web-request', device: W, path: '^/app/', status: 200, backend: 'app1', engine: 'apache' }, { type: 'web-request', device: W, path: '^/$', status: 200, engine: 'apache', label: 'The static site still answers at /' }] },
    ],
  },
  {
    id: 'lx-40-apache-load-balancing',
    moduleId: MODULE,
    order: 7,
    title: 'Load Balancing With mod_proxy_balancer',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Define a balancer with two members and watch Apache spread requests over both application servers.',
    scenario:
      'A second application server, app2 (192.168.2.51), is online. Replace the single ProxyPass target with a balancer. Inside the virtual host add:\n\n<Proxy balancer://cluster>\n    BalancerMember http://192.168.2.50:8080\n    BalancerMember http://192.168.2.51:8080\n</Proxy>\nProxyPass /app/ balancer://cluster/\n\nRun configtest: it complains that it cannot find the byrequests load balancing method, because the balancer needs mod_proxy_balancer and a lbmethod module. Enable both, restart, then run four requests in a loop and watch the answers alternate.',
    concepts: ['<Proxy balancer://name> and BalancerMember', 'a2enmod proxy_balancer lbmethod_byrequests', 'Round robin', 'Verifying distribution with a loop'],
    hints: [
      'sudo a2enmod proxy_balancer lbmethod_byrequests enables both at once.',
      'sudo apache2ctl configtest then sudo systemctl restart apache2.',
      'for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done',
    ],
    createState: () => apacheSite({ running: true, conf: VHOST_PROXY, modules: ['proxy', 'proxy_http'] }),
    objectives: [
      { id: 'modules', label: 'Enable the balancer modules', checks: [{ type: 'apache-module', device: W, name: 'proxy_balancer' }, { type: 'apache-module', device: W, name: 'lbmethod_byrequests' }] },
      { id: 'conf', label: 'Balancer with both members', checks: [{ type: 'file', device: W, path: SITE, contains: 'balancer://cluster' }, { type: 'file', device: W, path: SITE, contains: 'BalancerMember\\s+http://192\\.168\\.2\\.50:8080' }, { type: 'file', device: W, path: SITE, contains: 'BalancerMember\\s+http://192\\.168\\.2\\.51:8080' }, { type: 'apache-config', device: W, valid: true }] },
      { id: 'loop', label: 'Request in a loop', checks: [{ type: 'command', device: W, pattern: '^for .*curl' }] },
      { id: 'spread', label: 'Both backends served requests', checks: [{ type: 'web-request', device: W, path: '^/app/', status: 200, backend: 'app1', engine: 'apache' }, { type: 'web-request', device: W, path: '^/app/', status: 200, backend: 'app2', engine: 'apache' }] },
    ],
  },
  {
    id: 'lx-41-apache-port-conflict',
    moduleId: MODULE,
    order: 8,
    title: 'Troubleshoot: Port 80 Is Already Taken',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Apache refuses to start because another web server already holds the port. Find it and decide what to do.',
    scenario:
      'This server was set up twice: nginx is running and Apache was installed afterwards. Try sudo systemctl start apache2 and read the failure, then look at systemctl status apache2 for the reason.\n\nFind out what is on port 80 with ss -tlnp. The team has standardised on Apache, so stop nginx and stop it coming back after a reboot, then start and enable Apache and confirm it answers.',
    concepts: ['Address already in use', 'ss -tlnp to find the listener', 'systemctl stop and disable', 'Only one process can bind a port'],
    hints: [
      'systemctl status apache2 shows: (98)Address already in use: AH00072: make_sock: could not bind to address 0.0.0.0:80',
      'sudo ss -tlnp shows nginx listening on port 80.',
      'sudo systemctl disable --now nginx, then sudo systemctl enable --now apache2.',
    ],
    createState: () => apacheSite({ nginx: true }),
    objectives: [
      { id: 'fail', label: 'See Apache fail to bind', checks: [{ type: 'command', device: W, pattern: '^sudo systemctl (start|enable --now) apache2$' }, { type: 'shell-output', device: W, pattern: 'Address already in use', label: 'Saw the bind failure' }] },
      { id: 'find', label: 'Find what holds the port', checks: [{ type: 'command', device: W, pattern: '^(sudo )?ss\\b.*p' }] },
      { id: 'nginx', label: 'Stop and disable nginx', checks: [{ type: 'service', device: W, name: 'nginx', active: false, enabled: false }] },
      { id: 'apache', label: 'Apache runs, enabled, and answers', checks: [{ type: 'service', device: W, name: 'apache2', active: true, enabled: true }, { type: 'web-request', device: W, status: 200, engine: 'apache' }] },
    ],
  },
  {
    id: 'lx-42-exam-apache-front-end',
    moduleId: MODULE,
    order: 9,
    title: 'Exam: Apache Front End',
    difficulty: 'Advanced',
    estimatedMinutes: 25,
    description: 'Build the whole front end on Apache: modules, TLS, a redirect, HSTS, a static site and a balanced API.',
    scenario:
      'Stand up www.lab.local on web1 with Apache.\n\nEnable the modules you need (ssl, headers, proxy, proxy_http, proxy_balancer and a lbmethod). Create a self-signed certificate and key for www.lab.local under /etc/ssl (key mode 600). Publish a static site from /var/www/www whose index contains the word Production.\n\nWrite /etc/apache2/sites-available/www.conf with a *:80 virtual host that redirects permanently to https://www.lab.local/, and a *:443 virtual host for www.lab.local with SSLEngine on, the certificate and key, the Strict-Transport-Security header, DocumentRoot /var/www/www, a <Proxy balancer://cluster> listing app1 and app2 on port 8080, and ProxyPass /api/ balancer://cluster/. Enable the site, test the configuration and restart Apache.\n\nProve it: curl -I http://www.lab.local returns 301, curl -kI https://www.lab.local returns 200, and four requests to https://www.lab.local/api/ are answered by both backends.',
    concepts: ['Synthesis', 'Module management', 'TLS and redirects', 'HSTS', 'Static content and a balanced API in one virtual host'],
    hints: [],
    isExam: true,
    createState: () => apacheSite({ running: true }),
    objectives: [
      { id: 'modules', label: 'Every module enabled', checks: [{ type: 'apache-module', device: W, name: 'ssl' }, { type: 'apache-module', device: W, name: 'headers' }, { type: 'apache-module', device: W, name: 'proxy_http' }, { type: 'apache-module', device: W, name: 'proxy_balancer' }, { type: 'apache-module', device: W, name: 'lbmethod_byrequests' }] },
      { id: 'tls', label: 'Certificate and protected key', checks: [{ type: 'file', device: W, path: '/etc/ssl/certs/www.crt', contains: 'BEGIN CERTIFICATE' }, { type: 'file', device: W, path: '/etc/ssl/private/www.key', mode: '600', owner: 'root' }] },
      { id: 'site', label: 'Static site published', checks: [{ type: 'file', device: W, path: '/var/www/www/index.html', contains: 'Production' }] },
      { id: 'conf', label: 'Virtual hosts, HSTS and balancer configured', checks: [{ type: 'apache-config', device: W, valid: true }, { type: 'apache-site', device: W, name: 'www' }, { type: 'file', device: W, path: '/etc/apache2/sites-available/www.conf', contains: 'Redirect\\s+permanent' }, { type: 'file', device: W, path: '/etc/apache2/sites-available/www.conf', contains: 'Strict-Transport-Security' }, { type: 'file', device: W, path: '/etc/apache2/sites-available/www.conf', contains: 'BalancerMember\\s+http://192\\.168\\.2\\.51:8080' }] },
      { id: 'proof', label: 'Redirect, HTTPS and both backends proven', checks: [{ type: 'web-request', device: W, scheme: 'http', host: '^www\\.lab\\.local$', status: 301, engine: 'apache' }, { type: 'web-request', device: W, scheme: 'https', host: '^www\\.lab\\.local$', path: '^/$', status: 200, engine: 'apache' }, { type: 'web-request', device: W, scheme: 'https', path: '^/api/', status: 200, backend: 'app1' }, { type: 'web-request', device: W, scheme: 'https', path: '^/api/', status: 200, backend: 'app2' }] },
    ],
  },
];
