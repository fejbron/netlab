import { buildNetwork, createRouter, createSwitch, makeCertificate, makePrivateKey, type LinuxSpec, type NetworkState } from '../../engine';
import type { Lab } from '../types';

const MODULE = 'linux-web';
const W = 'web1';

const HOSTS_FILE = '127.0.0.1 localhost\n127.0.1.1 web1\n127.0.0.1 netlab.lab.local shop.lab.local\n192.168.2.50 app1\n192.168.2.51 app2\n\n::1 ip6-localhost ip6-loopback\n';
const SITE_HTML = '<!DOCTYPE html>\n<html>\n<head><title>NetLab</title></head>\n<body><h1>NetLab site</h1></body>\n</html>\n';

const CONF_80 = `server {
    listen 80;
    server_name netlab.lab.local;
    root /var/www/netlab;
    index index.html;
}
`;

const CONF_TLS = `server {
    listen 80;
    listen 443 ssl;
    server_name netlab.lab.local;
    ssl_certificate /etc/ssl/certs/netlab.crt;
    ssl_certificate_key /etc/ssl/private/netlab.key;
    root /var/www/netlab;
    index index.html;
}
`;

const CONF_PROXY = `server {
    listen 80;
    server_name netlab.lab.local;
    root /var/www/netlab;
    index index.html;

    location /app/ {
        proxy_pass http://192.168.2.50:8080/;
        proxy_set_header Host $host;
    }
}
`;

const CONF_LB = `upstream backend {
    server 192.168.2.50:8080;
    server 192.168.2.51:8080;
}

server {
    listen 80;
    server_name netlab.lab.local;
    root /var/www/netlab;
    index index.html;

    location /app/ {
        proxy_pass http://backend/;
        proxy_set_header Host $host;
    }
}
`;

const CONF_BROKEN = `server {
    listen 80;
    servr_name netlab.lab.local;
    root /var/www/netlab
    index index.html;
}
`;

interface SiteOpts {
  /** nginx running at the start (its configuration is loaded lazily on the first request). */
  nginxActive?: boolean;
  /** Extra configuration file placed in /etc/nginx/conf.d/netlab.conf. */
  conf?: string;
  /** Pre-populate /etc/hosts with the lab names. */
  hosts?: boolean;
  /** Pre-create the self-signed certificate and key for netlab.lab.local. */
  certs?: boolean;
  /** app2's application is stopped. */
  app2Down?: boolean;
}

/**
 * web1 192.168.1.50 (nginx) and PC-A on SW1 behind R1; app1 192.168.2.50 and app2 192.168.2.51
 * (demo application on 8080) on SW2 behind R2. R1 and R2 route between the sites.
 */
function webSite(opts: SiteOpts = {}): NetworkState {
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
  const web: LinuxSpec = {
    hostname: 'web1',
    packages: ['nginx', 'openssl'],
    services: { nginx: { active: Boolean(opts.nginxActive), enabled: Boolean(opts.nginxActive) } },
    files: {
      '/var/www/netlab/index.html': SITE_HTML,
      ...(opts.conf ? { '/etc/nginx/conf.d/netlab.conf': opts.conf } : {}),
      ...(opts.hosts ? { '/etc/hosts': HOSTS_FILE } : {}),
      ...(opts.certs ? { '/etc/ssl/certs/netlab.crt': makeCertificate('/CN=netlab.lab.local', 365), '/etc/ssl/private/netlab.key': { content: makePrivateKey('/CN=netlab.lab.local'), mode: 0o600 } } : {}),
    },
  };
  const app = (hostname: string, active: boolean): LinuxSpec => ({ hostname, packages: ['netlab-app'], services: { app: { active, enabled: true } } });
  return buildNetwork({
    primary: W,
    devices: [r1, r2, sw1, sw2],
    hosts: [
      { id: 'web1', ip: '192.168.1.50', mask: '255.255.255.0', gateway: '192.168.1.1', linux: web },
      { id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { id: 'app1', ip: '192.168.2.50', mask: '255.255.255.0', gateway: '192.168.2.1', linux: app('app1', true) },
      { id: 'app2', ip: '192.168.2.51', mask: '255.255.255.0', gateway: '192.168.2.1', linux: app('app2', !opts.app2Down) },
    ],
    links: [['web1', 'SW1:g0/1'], ['PC-A', 'SW1:g0/2'], ['SW1:g0/8', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1'], ['R2:g0/0', 'SW2:g0/8'], ['app1', 'SW2:g0/1'], ['app2', 'SW2:g0/2']],
  });
}

const CONF = '/etc/nginx/conf.d/netlab.conf';

export const linuxWebLabs: Lab[] = [
  {
    id: 'lx-25-serve-a-site-with-nginx',
    moduleId: MODULE,
    order: 1,
    title: 'Serve a Site With nginx',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Read the nginx layout, write a server block for a site, enable it, test the configuration and start the server.',
    scenario:
      'nginx is installed on web1 but not running. Read /etc/nginx/nginx.conf and notice the include of sites-enabled; list /etc/nginx/sites-enabled to see the default site symlink.\n\nCreate the document root /var/www/netlab with an index.html that says NetLab site (the directory belongs to root, so use sudo). Write /etc/nginx/sites-available/netlab.conf with a server block that listens on 80, has server_name netlab.lab.local, root /var/www/netlab and index index.html. Enable it with a symlink in sites-enabled, test with sudo nginx -t, then start and enable nginx.\n\nTest with the Host header, from web1 and from PC-A: curl -H "Host: netlab.lab.local" http://192.168.1.50',
    concepts: ['nginx.conf, sites-available and sites-enabled', 'server, listen, server_name, root, index', 'nginx -t before every reload', 'Name-based virtual hosting and the Host header'],
    hints: ['sudo mkdir -p /var/www/netlab; echo "<h1>NetLab site</h1>" | sudo tee /var/www/netlab/index.html', "sudo tee /etc/nginx/sites-available/netlab.conf << 'EOF' … server { listen 80; server_name netlab.lab.local; root /var/www/netlab; index index.html; } … EOF", 'sudo ln -s /etc/nginx/sites-available/netlab.conf /etc/nginx/sites-enabled/; sudo nginx -t; sudo systemctl enable --now nginx; curl -H "Host: netlab.lab.local" http://192.168.1.50'],
    createState: () => webSite(),
    objectives: [
      { id: 'look', label: 'Read the layout', checks: [{ type: 'command', device: W, pattern: '^(cat|less) /etc/nginx/nginx\\.conf' }, { type: 'command', device: W, pattern: '^ls\\b.*sites-enabled' }] },
      { id: 'root', label: 'Create the document root', checks: [{ type: 'file', device: W, path: '/var/www/netlab/index.html', contains: 'NetLab site' }] },
      { id: 'conf', label: 'Write and enable the server block', checks: [{ type: 'file', device: W, path: '/etc/nginx/sites-available/netlab.conf', contains: 'server_name\\s+netlab\\.lab\\.local' }, { type: 'file', device: W, path: '/etc/nginx/sites-available/netlab.conf', contains: 'root\\s+/var/www/netlab' }, { type: 'file', device: W, path: '/etc/nginx/sites-enabled/netlab.conf', kind: 'link', label: 'Symlink in sites-enabled' }] },
      { id: 'test', label: 'Test the configuration', checks: [{ type: 'command', device: W, pattern: '^sudo nginx -t$' }, { type: 'nginx-config', device: W, valid: true }] },
      { id: 'run', label: 'nginx running and enabled', checks: [{ type: 'service', device: W, name: 'nginx', active: true, enabled: true }] },
      { id: 'serve', label: 'The site answers to its name', checks: [{ type: 'web-request', device: W, host: '^netlab\\.lab\\.local$', status: 200, server: 'netlab.lab.local' }, { type: 'command', device: 'PC-A', pattern: '^curl\\b.*Host: netlab\\.lab\\.local', label: 'Fetched from PC-A with the Host header' }] },
    ],
  },
  {
    id: 'lx-26-virtual-hosts',
    moduleId: MODULE,
    order: 2,
    title: 'Two Sites, One Server',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Add a second name-based virtual host, resolve the names locally, and see where unknown names land.',
    scenario:
      'netlab.lab.local is served from /etc/nginx/conf.d/netlab.conf. Add shop.lab.local with its own root /var/www/shop and an index that says Shop. Test the configuration and reload nginx (a reload keeps serving while it re-reads the files).\n\nThere is no DNS in the lab, so add "127.0.0.1 netlab.lab.local shop.lab.local" to /etc/hosts and fetch both sites by name from web1. Then fetch with an unknown Host (curl -H "Host: nobody.example" http://192.168.1.50) and notice that nginx answers with the default server, which is still the Ubuntu default site.',
    concepts: ['Several server blocks on one port', 'default_server and the fallback for unknown names', '/etc/hosts for local name resolution', 'systemctl reload nginx'],
    hints: ["sudo mkdir -p /var/www/shop; echo '<h1>Shop</h1>' | sudo tee /var/www/shop/index.html; then a server block in /etc/nginx/conf.d/shop.conf with server_name shop.lab.local and root /var/www/shop.", 'sudo nginx -t; sudo systemctl reload nginx.', 'echo "127.0.0.1 netlab.lab.local shop.lab.local" | sudo tee -a /etc/hosts; curl http://shop.lab.local; curl http://netlab.lab.local; curl -H "Host: nobody.example" http://192.168.1.50'],
    createState: () => webSite({ nginxActive: true, conf: CONF_80 }),
    objectives: [
      { id: 'shop', label: 'Second virtual host', checks: [{ type: 'file', device: W, path: '/var/www/shop/index.html', contains: 'Shop' }, { type: 'file', device: W, path: '/etc/nginx/conf.d/shop.conf', contains: 'server_name\\s+shop\\.lab\\.local' }, { type: 'nginx-config', device: W, valid: true }] },
      { id: 'names', label: 'Resolve the names locally', checks: [{ type: 'file', device: W, path: '/etc/hosts', contains: 'shop\\.lab\\.local' }, { type: 'command', device: W, pattern: '^curl\\b.*http://shop\\.lab\\.local' }] },
      { id: 'both', label: 'Both sites answer', checks: [{ type: 'web-request', device: W, host: '^shop\\.lab\\.local$', status: 200, server: 'shop.lab.local' }, { type: 'web-request', device: W, host: '^netlab\\.lab\\.local$', status: 200, server: 'netlab.lab.local' }] },
      { id: 'fallback', label: 'An unknown name lands on the default server', checks: [{ type: 'web-request', device: W, host: 'nobody', status: 200, server: '_' }] },
    ],
  },
  {
    id: 'lx-27-troubleshoot-nginx-config',
    moduleId: MODULE,
    order: 3,
    title: "Troubleshoot: nginx Won't Start",
    difficulty: 'Intermediate',
    estimatedMinutes: 8,
    description: 'A colleague broke the configuration. Read what nginx -t says, fix exactly that, and bring the site back.',
    scenario:
      'After an edit to /etc/nginx/conf.d/netlab.conf, nginx would not restart and the site is down. Try sudo systemctl start nginx and read the failure, then let nginx tell you what is wrong with sudo nginx -t.\n\nFix the file (sed -i or rewrite it), test again until the test is successful, start nginx, and confirm the site answers to curl -H "Host: netlab.lab.local" http://192.168.1.50.',
    concepts: ['Reading nginx -t errors with file and line', 'Unknown directives and missing semicolons', 'systemctl status for the failure reason', 'Fix, test, start'],
    hints: ['sudo nginx -t reports the first problem with its file and line. There are two problems in the file.', "sudo sed -i 's/servr_name/server_name/' /etc/nginx/conf.d/netlab.conf fixes the typo; the root line is missing its semicolon.", 'sudo nginx -t until it says test is successful, then sudo systemctl start nginx.'],
    createState: () => webSite({ conf: CONF_BROKEN }),
    objectives: [
      { id: 'diagnose', label: 'Let nginx explain the failure', checks: [{ type: 'command', device: W, pattern: '^sudo nginx -t$' }, { type: 'shell-output', device: W, pattern: 'nginx: \\[emerg\\]', label: 'Saw an [emerg] error' }] },
      { id: 'fix', label: 'Fix the configuration', checks: [{ type: 'file', device: W, path: CONF, contains: 'server_name\\s+netlab\\.lab\\.local;' }, { type: 'file', device: W, path: CONF, notContains: 'servr_name' }, { type: 'nginx-config', device: W, valid: true }] },
      { id: 'up', label: 'nginx runs again and serves the site', checks: [{ type: 'service', device: W, name: 'nginx', active: true }, { type: 'web-request', device: W, host: '^netlab\\.lab\\.local$', status: 200 }] },
    ],
  },
  {
    id: 'lx-28-self-signed-tls',
    moduleId: MODULE,
    order: 4,
    title: 'Self-Signed TLS',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Create a key and a self-signed certificate with openssl, protect the key, and serve the site over HTTPS.',
    scenario:
      'The site must be reachable over HTTPS. There is no public CA in the lab, so create a self-signed certificate: openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/netlab.key -out /etc/ssl/certs/netlab.crt -subj "/CN=netlab.lab.local" (with sudo). Make sure the key is readable by root only (mode 600) and inspect the certificate with openssl x509 -in ... -noout -subject -dates.\n\nAdd listen 443 ssl plus ssl_certificate and ssl_certificate_key to the server block in /etc/nginx/conf.d/netlab.conf, test and reload. Fetch https://192.168.1.50 with the Host header: without -k curl refuses the self-signed certificate; with -k it shows the page.',
    concepts: ['openssl req -x509 -newkey -nodes -subj', 'Private key permissions', 'listen 443 ssl, ssl_certificate, ssl_certificate_key', 'Why curl rejects self-signed certificates and what -k does'],
    hints: ['The openssl command is in the scenario; run it with sudo so the files land under /etc/ssl.', 'sudo chmod 600 /etc/ssl/private/netlab.key; sudo openssl x509 -in /etc/ssl/certs/netlab.crt -noout -subject -dates', 'Add listen 443 ssl; ssl_certificate /etc/ssl/certs/netlab.crt; ssl_certificate_key /etc/ssl/private/netlab.key; to the server block, then sudo nginx -t and sudo systemctl reload nginx. curl -k -H "Host: netlab.lab.local" https://192.168.1.50'],
    createState: () => webSite({ nginxActive: true, conf: CONF_80 }),
    objectives: [
      { id: 'cert', label: 'Certificate and key created', checks: [{ type: 'file', device: W, path: '/etc/ssl/certs/netlab.crt', contains: 'BEGIN CERTIFICATE' }, { type: 'file', device: W, path: '/etc/ssl/private/netlab.key', contains: 'PRIVATE KEY' }, { type: 'command', device: W, pattern: 'openssl req\\b.*-x509' }] },
      { id: 'protect', label: 'Key readable by root only', checks: [{ type: 'file', device: W, path: '/etc/ssl/private/netlab.key', mode: '600', owner: 'root' }] },
      { id: 'inspect', label: 'Inspect the certificate', checks: [{ type: 'command', device: W, pattern: 'openssl x509\\b.*-in' }] },
      { id: 'conf', label: 'TLS listener configured', checks: [{ type: 'file', device: W, path: CONF, contains: 'listen\\s+443\\s+ssl' }, { type: 'file', device: W, path: CONF, contains: 'ssl_certificate_key\\s+/etc/ssl/private/netlab\\.key' }, { type: 'nginx-config', device: W, valid: true }] },
      { id: 'https', label: 'HTTPS answers', checks: [{ type: 'web-request', device: W, scheme: 'https', host: '^netlab\\.lab\\.local$', status: 200 }, { type: 'shell-output', device: W, pattern: '\\(60\\) SSL certificate problem', label: 'Saw curl reject the self-signed certificate without -k' }] },
    ],
  },
  {
    id: 'lx-29-redirect-http-to-https',
    moduleId: MODULE,
    order: 5,
    title: 'Redirect HTTP to HTTPS',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Send every plain-HTTP request to HTTPS with a 301, add HSTS, and follow the redirect with curl.',
    scenario:
      'netlab.lab.local already serves HTTPS on 443 and plain HTTP on 80 from the same server block. Split them: a server on port 80 that only does return 301 https://$host$request_uri; and the TLS server on 443 which adds the header Strict-Transport-Security "max-age=31536000" always.\n\nTest and reload. Check the redirect with curl -I http://netlab.lab.local (status 301 and a Location header), then follow it with curl -kLi http://netlab.lab.local and find the HSTS header in the final response.',
    concepts: ['return 301 and $host$request_uri', 'One server block per port', 'add_header Strict-Transport-Security', 'curl -I and curl -L'],
    hints: ['server { listen 80; server_name netlab.lab.local; return 301 https://$host$request_uri; }', 'In the 443 server: add_header Strict-Transport-Security "max-age=31536000" always;', 'sudo nginx -t; sudo systemctl reload nginx; curl -I http://netlab.lab.local; curl -kLi http://netlab.lab.local'],
    createState: () => webSite({ nginxActive: true, conf: CONF_TLS, hosts: true, certs: true }),
    objectives: [
      { id: 'conf', label: 'Redirect and HSTS configured', checks: [{ type: 'file', device: W, path: CONF, contains: 'return\\s+301\\s+https://\\$host\\$request_uri' }, { type: 'file', device: W, path: CONF, contains: 'Strict-Transport-Security' }, { type: 'nginx-config', device: W, valid: true }] },
      { id: 'redirect', label: 'Plain HTTP is redirected', checks: [{ type: 'web-request', device: W, scheme: 'http', host: '^netlab\\.lab\\.local$', status: 301 }, { type: 'command', device: W, pattern: '^curl\\b.*-\\w*I' , label: 'Checked the headers with curl -I' }] },
      { id: 'follow', label: 'Following the redirect reaches HTTPS', checks: [{ type: 'command', device: W, pattern: '^curl\\b.*-\\w*L' }, { type: 'web-request', device: W, scheme: 'https', host: '^netlab\\.lab\\.local$', status: 200 }] },
    ],
  },
  {
    id: 'lx-30-reverse-proxy',
    moduleId: MODULE,
    order: 6,
    title: 'Reverse Proxy to an Application',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Put nginx in front of an application server so clients only ever talk to the web front end.',
    scenario:
      'app1 (192.168.2.50) runs the demo application on port 8080; from web1, curl http://192.168.2.50:8080 shows "Hello from app1". Clients should not reach it directly. Add to the netlab.lab.local server block:\n\nlocation /app/ {\n    proxy_pass http://192.168.2.50:8080/;\n    proxy_set_header Host $host;\n}\n\nTest and reload, then fetch http://netlab.lab.local/app/ from web1 and from PC-A (with the Host header). The response comes from app1, through nginx.',
    concepts: ['location and proxy_pass', 'Trailing slash and path rewriting', 'proxy_set_header Host', 'Front end versus backend'],
    hints: ['curl http://192.168.2.50:8080 first to see the backend answer directly.', 'Add the location block from the scenario inside the server block in /etc/nginx/conf.d/netlab.conf.', 'sudo nginx -t; sudo systemctl reload nginx; curl http://netlab.lab.local/app/'],
    createState: () => webSite({ nginxActive: true, conf: CONF_80, hosts: true }),
    objectives: [
      { id: 'direct', label: 'See the backend directly', checks: [{ type: 'command', device: W, pattern: '^curl\\b.*192\\.168\\.2\\.50:8080' }] },
      { id: 'conf', label: 'proxy_pass configured', checks: [{ type: 'file', device: W, path: CONF, contains: 'proxy_pass\\s+http://192\\.168\\.2\\.50:8080' }, { type: 'nginx-config', device: W, valid: true }] },
      { id: 'proxied', label: 'Requests to /app/ are served by app1 through nginx', checks: [{ type: 'web-request', device: W, path: '^/app/', status: 200, backend: 'app1' }, { type: 'command', device: 'PC-A', pattern: '^curl\\b.*/app/', label: 'Fetched /app/ from PC-A' }] },
    ],
  },
  {
    id: 'lx-31-load-balancing',
    moduleId: MODULE,
    order: 7,
    title: 'Load Balance Across Two Backends',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Define an upstream group and watch nginx spread requests over two application servers.',
    scenario:
      'A second application server, app2 (192.168.2.51), is online. Replace the single proxy_pass target with an upstream group named backend that lists both servers on port 8080, and point the /app/ location at http://backend/.\n\nTest and reload, then run four requests in a loop: for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done. The answers alternate between app1 and app2: that is round-robin load balancing.',
    concepts: ['upstream { server ...; }', 'proxy_pass http://<upstream>/', 'Round robin', 'Verifying distribution with a loop'],
    hints: ['upstream backend { server 192.168.2.50:8080; server 192.168.2.51:8080; } goes at the top of the file, outside the server block.', 'location /app/ { proxy_pass http://backend/; proxy_set_header Host $host; }', 'for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done'],
    createState: () => webSite({ nginxActive: true, conf: CONF_PROXY, hosts: true }),
    objectives: [
      { id: 'conf', label: 'Upstream with both backends', checks: [{ type: 'file', device: W, path: CONF, contains: 'upstream\\s+backend' }, { type: 'file', device: W, path: CONF, contains: 'server\\s+192\\.168\\.2\\.50:8080' }, { type: 'file', device: W, path: CONF, contains: 'server\\s+192\\.168\\.2\\.51:8080' }, { type: 'file', device: W, path: CONF, contains: 'proxy_pass\\s+http://backend' }, { type: 'nginx-config', device: W, valid: true }] },
      { id: 'loop', label: 'Request in a loop', checks: [{ type: 'command', device: W, pattern: '^for .*curl' }] },
      { id: 'spread', label: 'Both backends served requests', checks: [{ type: 'web-request', device: W, path: '^/app/', status: 200, backend: 'app1' }, { type: 'web-request', device: W, path: '^/app/', status: 200, backend: 'app2' }] },
    ],
  },
  {
    id: 'lx-32-backend-down',
    moduleId: MODULE,
    order: 8,
    title: 'Troubleshoot: One Backend Is Down',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Notice that every answer comes from one server, find the failed backend, and bring it back.',
    scenario:
      'The load balancer is configured for app1 and app2, but the loop for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done only ever prints app1. nginx skips a backend it cannot reach, so users see no error, which is exactly why nobody noticed.\n\nFrom web1, test the backend directly: curl http://192.168.2.51:8080. Then open the app2 console, check the app service with systemctl status app, and start it. Back on web1, run the loop again and confirm both backends answer.',
    concepts: ['Passive health checks and silent failover', 'Testing a backend directly', 'systemctl status on the backend', 'Verifying recovery'],
    hints: ['curl http://192.168.2.51:8080 from web1 is refused: nothing listens on app2.', 'On app2: systemctl status app shows inactive (dead). sudo systemctl start app.', 'On web1: for i in 1 2 3 4; do curl -s http://netlab.lab.local/app/; done now alternates.'],
    createState: () => webSite({ nginxActive: true, conf: CONF_LB, hosts: true, app2Down: true }),
    objectives: [
      { id: 'observe', label: 'Observe the failover', checks: [{ type: 'command', device: W, pattern: '^for .*curl' }, { type: 'shell-output', device: W, pattern: '\\(7\\) Failed to connect to 192\\.168\\.2\\.51 port 8080', label: 'Saw the direct connection to app2 refused' }] },
      { id: 'diagnose', label: 'Diagnose on app2', checks: [{ type: 'command', device: 'app2', pattern: '^(sudo )?systemctl status app' }] },
      { id: 'fix', label: 'Start the application on app2', checks: [{ type: 'service', device: 'app2', name: 'app', active: true }] },
      { id: 'verify', label: 'Both backends serve again', checks: [{ type: 'web-request', device: W, path: '^/app/', status: 200, backend: 'app2' }, { type: 'web-request', device: W, path: '^/app/', status: 200, backend: 'app1' }] },
    ],
  },
  {
    id: 'lx-33-exam-web-front-end',
    moduleId: MODULE,
    order: 9,
    title: 'Exam: Production Web Front End',
    difficulty: 'Advanced',
    estimatedMinutes: 25,
    description: 'Build the complete front end: TLS with a redirect from HTTP, HSTS, a static site, and a load-balanced API behind it.',
    scenario:
      'Stand up www.lab.local on web1 from scratch.\n\nCreate a self-signed certificate and key for www.lab.local under /etc/ssl (key mode 600). Publish a static site from /var/www/www whose index contains the word Production. Configure nginx with: a server on 80 that returns 301 to https://$host$request_uri; a server on 443 ssl for www.lab.local with the Strict-Transport-Security header, the static root, and a location /api/ proxied to an upstream named backend that lists app1 and app2 (192.168.2.50 and 192.168.2.51, port 8080) using least_conn. Enable and start nginx.\n\nAdd www.lab.local to /etc/hosts on web1 and prove it: curl -I http://www.lab.local shows 301, curl -kI https://www.lab.local shows 200, and four requests to https://www.lab.local/api/ are answered by both backends.',
    concepts: ['Synthesis', 'TLS and redirects', 'HSTS', 'Static content and reverse proxy in one server', 'Upstream with least_conn'],
    hints: [],
    isExam: true,
    createState: () => webSite(),
    objectives: [
      { id: 'tls', label: 'Certificate and protected key', checks: [{ type: 'file', device: W, path: '/etc/ssl/certs/www.crt', contains: 'BEGIN CERTIFICATE' }, { type: 'file', device: W, path: '/etc/ssl/private/www.key', mode: '600', owner: 'root' }] },
      { id: 'site', label: 'Static site published', checks: [{ type: 'file', device: W, path: '/var/www/www/index.html', contains: 'Production' }] },
      { id: 'conf', label: 'Configuration: redirect, TLS, HSTS, upstream with least_conn', checks: [{ type: 'nginx-config', device: W, valid: true }, { type: 'file', device: W, path: '/etc/nginx/conf.d/www.conf', contains: 'return\\s+301\\s+https://\\$host\\$request_uri' }, { type: 'file', device: W, path: '/etc/nginx/conf.d/www.conf', contains: 'listen\\s+443\\s+ssl' }, { type: 'file', device: W, path: '/etc/nginx/conf.d/www.conf', contains: 'Strict-Transport-Security' }, { type: 'file', device: W, path: '/etc/nginx/conf.d/www.conf', contains: 'least_conn' }, { type: 'file', device: W, path: '/etc/nginx/conf.d/www.conf', contains: 'server\\s+192\\.168\\.2\\.51:8080' }] },
      { id: 'run', label: 'nginx running and enabled', checks: [{ type: 'service', device: W, name: 'nginx', active: true, enabled: true }] },
      { id: 'proof', label: 'Redirect, HTTPS and both backends proven', checks: [{ type: 'web-request', device: W, scheme: 'http', host: '^www\\.lab\\.local$', status: 301 }, { type: 'web-request', device: W, scheme: 'https', host: '^www\\.lab\\.local$', path: '^/$', status: 200 }, { type: 'web-request', device: W, scheme: 'https', path: '^/api/', status: 200, backend: 'app1' }, { type: 'web-request', device: W, scheme: 'https', path: '^/api/', status: 200, backend: 'app2' }] },
    ],
  },
];
