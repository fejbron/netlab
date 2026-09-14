# NetLab

[![CI](https://github.com/fejbron/netlab/actions/workflows/ci.yml/badge.svg)](https://github.com/fejbron/netlab/actions/workflows/ci.yml)

Open-source network CLI labs that run entirely in your browser. Practise Cisco IOS switch configuration in a simulated terminal, get graded live against lab objectives, and track progress on your device. No installs, no accounts, no payments.

> Status: early MVP. Four learning paths. **CCNA**: Cisco IOS switches and routers, PCs with a mini terminal, 91 labs across fourteen modules (Meet the CLI, Learn Switching, Learn EtherChannel, Learn Spanning Tree, Secure the Switch, Learn Routing, Learn OSPF, Learn ACLs, Learn DHCP, Learn NAT, Learn IPv6, Learn Network Security, Learn Automation & AI Network Operations, CCNA Exams), a faithful command resolver, a packet-forwarding simulation with per-VLAN spanning tree, multi-area OSPF, enforced access lists, DHCP, NAT, IPv6, EtherChannel, port security, DHCP snooping and dynamic ARP inspection, and a RESTCONF API reachable with `curl`. **Linux**: a simulated Ubuntu server with a Bash-subset shell, a virtual filesystem with owners and permissions, users, sudo, systemd services, apt, processes and logs, nginx and Apache web servers with virtual hosts, TLS, reverse proxying and load balancing, plus real Python (Pyodide) in the browser, 42 labs across six modules (Meet the Shell, Administer the Server, Shell Scripting, Web Servers/TLS/Load Balancing, Apache HTTP Server, Python on Linux) mapped to the LFCS domains. **SQL**: a PostgreSQL-flavoured database engine behind a real `psql` prompt, with a parser and planner written from scratch, 30 labs across six modules (Query the Database, Combine and Summarise, Change the Data, Design the Schema, Make It Fast and Safe, SQL Exams). **Terraform**: a Terraform 1.12 simulator with its own HCL parser, plan and apply engine, state backends and providers, managing a vendor-neutral simulated cloud (NetLab Cloud), 32 labs across seven modules (Meet Terraform, Providers and State, Variables/Expressions/Dependencies, Modules, Manage State and Troubleshoot, HCP Terraform, Terraform Exams) mapped to the Terraform Associate (004) objectives. Labs unlock in order within each path. See the roadmap below.

## Features

- **Realistic IOS CLI**: mode hierarchy (`>`, `#`, `(config)#`, `(config-if)#`, `(config-subif)#`, `(config-vlan)#`, `(config-line)#`), prefix abbreviation (`conf t`, `sh run`), Tab completion, `?` context help, `do` from config mode, and the authentic error messages (`% Invalid input detected at '^' marker.`, `% Incomplete command.`, `% Ambiguous command`).
- **Stateful switch model**: hostname, banner, enable secret, local users, console/VTY lines, VLAN database, access and trunk ports, `interface range`, SVIs, default gateway, SSH keys, password encryption, running vs startup config, and `show` output that matches real formatting.
- **EtherChannel**: `channel-group` with LACP (active/passive), PAgP (desirable/auto) and static (on) modes, `interface Port-channel` whose settings flow to member ports, negotiation rules evaluated from both ends of each link, members flagged P/I/s/D, and `show etherchannel summary`.
- **Spanning tree**: per-VLAN root election by bridge ID (priority + MAC), root path cost, root/designated/alternate port roles with the loop-breaking ports blocked in the forwarding simulation (so the network reconverges when a link fails or the root moves), `spanning-tree vlan N priority` and `root primary`/`secondary`, `spanning-tree mode pvst|rapid-pvst`, per-port `cost`, PortFast and BPDU guard (which err-disables a port that faces a switch), and IOS-style `show spanning-tree [vlan N]`.
- **Port security**: `switchport port-security` with maximum, static and sticky addresses and shutdown/restrict/protect violation modes, enforced when a PC sends traffic. Violations err-disable the port (or drop frames), `shutdown` / `no shutdown` recovers it, and `show port-security` (interface and address) reports the state.
- **Leaderboard per path**: a board for each learning path, ranked by points, then labs passed, then who got there first. A learner appears on a path's board once they have passed something on it. Points and the path are stored on each progress row because the totals are worked out in SQL, where the lab catalogue is not available. A database that predates either column still works: the board falls back to stars, or to the combined ranking, and says on the page which setting would fix it.
- **Progression**: labs unlock in order, so passing the last lab of a module opens the next module.
- **Home page**: the site root is a landing page that explains what NetLab is and shows it working. A terminal types real commands from the labs and prints the real answers, cycling through a Cisco switch rejecting a mistyped command, nginx refusing to load a broken file, and a SQL query returning nothing because it compared a column to NULL. Sections lift into place as they are scrolled to, counters count up, an objectives panel ticks itself off and a packet runs along a topology. Every one of those checks `prefers-reduced-motion` first and shows its finished state instead, and the content is in the document either way, so nothing depends on an animation running. Each learning path has its own dashboard at `/paths/<id>`.
- **Learning path dashboard**: a "continue your course" card picks the next lab (an unfinished session first, then the next open lab), a sticky stage navigator shows a progress ring per module, and every lab row reports its status (not started, *n of m objectives* from the saved console, completed) with a Begin / Resume / Replay action. Stars are explained in place: 3 for a pass with no hints, 2 with some, 1 with all of them.
- **CCNA 200-301 v1.1 exam blueprint**: each module is tagged with the blueprint topics it practises (`examTopics` in `src/content/index.ts`, described in `src/content/blueprint.ts`). The dashboard lists Cisco's six exam domains with their published weighting, the labs that cover each one, and the learner's progress per domain, and says plainly which domains NetLab does not cover yet.
- **Router model**: routed interfaces, dot1Q subinterfaces, loopbacks, static and default routes with administrative distance, and an IOS 15 style `show ip route` with connected, local, static and OSPF routes grouped by classful network.
- **OSPF**: `router ospf`, router IDs (configured or elected from loopbacks and interfaces), `network` statements with wildcard masks and areas, `ip ospf <pid> area`, passive interfaces, interface cost and priority, DR/BDR election per segment, neighbours only when area and subnet match, SPF over the router graph with accumulated metrics, administrative distance 110, and `default-information originate` producing O*E2 defaults. Multi-area: intra-area SPF per area (`O`), inter-area routes learned through area border routers attached to the backbone (`O IA`), intra-area preferred over inter-area, and an area with no path to area 0 stays isolated. `show ip ospf neighbor`, `show ip ospf interface brief`, `show ip ospf`, `show ip protocols`, `show ip route ospf`.
- **Multi-device topologies with real forwarding**: labs can hold several switches, routers and PCs. `ping` and `traceroute` walk frames through switches (access, trunk, native and allowed VLANs, router subinterface tags) and route packets hop by hop, and only succeed when the reply can get back too.
- **Access lists**: standard and extended, numbered and named, with `host`, `any`, wildcards, `eq` ports (names or numbers), ICMP `echo`/`echo-reply`, sequence numbers and remarks. Applied with `ip access-group in|out` on router interfaces and `access-class` on VTY lines. Enforced in the forwarding simulation: a denied echo answers `U.U.U` on IOS and "Destination net unreachable" on a PC, a filtered reply times out, router-originated traffic bypasses outbound lists, and `show access-lists` counts matches.
- **DHCP**: `ip dhcp pool` with `network`, `default-router`, `dns-server`, excluded addresses, relay with `ip helper-address`, bindings, `show ip dhcp binding` and `show ip dhcp pool`. PCs marked as DHCP clients obtain leases with `ipconfig /renew` (local server first, then a reachable relay target) and drop them with `ipconfig /release`.
- **NAT**: `ip nat inside`/`outside` roles, static NAT, dynamic NAT with pools, PAT with a pool or an interface (`overload`), `show ip nat translations` and `statistics`, `clear ip nat translation *`. Translation happens in the forwarding simulation: sources are rewritten when crossing from inside to outside, replies to global addresses map back, the outside interface answers ARP for static globals and pool addresses, router-originated traffic is not translated, and a pool without `overload` runs out.
- **IPv6**: `ipv6 unicast-routing`, global addresses with prefix lengths, EUI-64, automatic and manual link-local addresses, `ipv6 enable`, static and default routes (including link-local next hops with an exit interface), `show ipv6 interface brief`, `show ipv6 route`, and IPv6 `ping`/`traceroute` from routers and PCs over the same forwarding engine. Hosts can be dual-stack.
- **Network security**: `security passwords min-length` rejects short secrets with the real IOS message, `login block-for`, per-line `exec-timeout`, `aaa new-model` with `aaa authentication login default local`, and `show login`. On switches, DHCP snooping (`ip dhcp snooping [vlan]`, `ip dhcp snooping trust`, option 82 control) is enforced in the DHCP simulation: an offer that arrives on an untrusted port is dropped, so a client cannot lease until the uplink is trusted. Dynamic ARP inspection (`ip arp inspection vlan`, `ip arp inspection trust`) silences a host on an untrusted port unless it holds a DHCP snooping binding, which is exactly what happens to a static server in the real world. `show ip dhcp snooping [binding]`, `show ip arp inspection [vlan N | interfaces]`.
- **Automation and AI network operations**: `ip http secure-server`, `ip http authentication local`, `restconf` and `netconf-yang` on every device, `show platform software yang-management process`, and a small RESTCONF server that speaks the `ietf-interfaces` and `Cisco-IOS-XE-native` models (GET, PATCH, PUT). Telemetry: `logging host` and `logging trap`, `snmp-server community | location | contact`, `ntp server`, with `show logging`, `show snmp community`, `show ntp status` (synchronised only when the server is reachable) and `show ntp associations`. Labs cover reading a device as JSON, pushing a change through the API, deploying from a JSON intent, feeding telemetry to an AI operations platform, and reviewing an AI-proposed change before trusting it.
- **Linux hosts**: a host can be a Linux server (`linux: { ... }` in the network spec). It gets an Ubuntu-style prompt and a Bash subset: quoting, variables and parameter expansion, `$(command)` and `$((arithmetic))`, pipes, `> >> 2> 2>&1 <`, heredocs typed line by line, `if`/`for`/`while`/`until`/`case`, functions with `local` and `return`, `test`/`[ ]`/`[[ ]]`, scripts run with `bash file` or `./file` (the x bit is enforced), `source`, `sudo` and `sudo -i`. Around 90 utilities: `ls cat echo printf mkdir touch cp mv rm ln chmod chown stat head tail wc grep sed awk cut sort uniq tr tee xargs find which id groups useradd usermod userdel groupadd passwd systemctl journalctl ps kill pkill apt ip ping traceroute ss curl wget hostnamectl man help` and more (`passwd` prompts interactively). The virtual filesystem enforces owner/group/other permissions, root-only areas and the execute bit; `/etc/passwd`, `/etc/group` and `/etc/shadow` are generated from the user database. Services listen on ports `ss` can see, and a PC can `curl` a Linux web server. Editors are not simulated; files are written with redirection or heredocs.
- **Web servers, TLS and load balancing**: nginx is modelled properly, not faked. Its configuration is parsed from `/etc/nginx/nginx.conf` through every `include` (`sites-enabled`, `conf.d`), and `nginx -t` reports real errors with file and line: unknown directives, a missing semicolon, an unterminated block, a duplicate `default_server`, an ssl listener with no certificate, an upstream host that does not resolve. A failed start leaves the service down and the reason in `systemctl status`; a failed reload keeps the old configuration serving. Requests are answered from the parsed model: `server_name` matching with wildcards and a `default_server` fallback, `location` matching (exact, prefix and regex), `root`/`alias`/`index`, `return 301` with `$host$request_uri`, `add_header`, static files honouring permissions, and 403/404 pages. `proxy_pass` forwards through the network simulation to another host, and an `upstream` block balances round-robin (with `weight`, `backup`, `down`, `least_conn` and `ip_hash`), skips a backend it cannot reach, and answers 502 when none is left. TLS listeners need a certificate and key that actually parse, and `openssl req -x509`, `genrsa`, `rsa` and `x509` create and inspect them.
- **Apache HTTP Server**: the Debian `apache2` layout, modelled the way the tooling actually behaves. `a2enmod`, `a2dismod`, `a2ensite`, `a2dissite`, `a2enconf` and `a2disconf` manage the symlinks; `apache2ctl configtest`, `-M` and `-S` inspect the result. Directives only exist when their module is loaded, so `SSLEngine`, `ProxyPass`, `Header` and `RewriteRule` each fail with the real `Invalid command '…', perhaps misspelled or defined by a module not included in the server configuration` until `a2enmod` runs. `ports.conf` only listens on 443 because of `<IfModule ssl_module>`, `mod_proxy` without `mod_proxy_http` answers 500 the way it does in production, and a balancer without an `lbmethod` module fails with `AH01179`. Virtual hosts match by `ServerName`/`ServerAlias` with the first host on a port as its default, and `Redirect`, `RewriteRule`, `Header`, `DocumentRoot`, `DirectoryIndex`, `ProxyPass` and `<Proxy balancer://…>` with `BalancerMember` all work.
- **Two servers, one host**: nginx and Apache share the request pipeline, so a host can run either or both. Whichever server holds a port answers on it, and starting the second one on a port the first already holds fails to bind with the message that server really prints.
- **curl that teaches**: `-i`, `-I`, `-L` (following redirects), `-H "Host: ..."`, `-o`, `-w '%{http_code}'`, `-u`, `-X`, `-d` and `-k`, with the failures learners must recognise: connection refused, timeout, `(60)` self-signed certificate (rejected during the handshake, so it never reaches the server log), `(35)` wrong version number when speaking TLS to a plain port, and nginx's own 400 when speaking HTTP to an ssl port.
- **Python in the browser**: `python3 script.py` and `python3 -c` hand the code to Pyodide (CPython compiled to WebAssembly, loaded from jsDelivr on first use, about 10 MB). The script sees the host's text files at their real paths, `sys.argv` and the working directory; files it writes under the home directory come back into the virtual filesystem, stdout can be redirected, and tracebacks and exit codes flow back to the shell. Grading checks the files a script produced, what it printed, and whether it exited cleanly. Vitest cannot run Pyodide, so the reference solutions for Python labs use per-lab expected results (see `src/engine/grader.test.ts`).
- **SQL and databases**: a relational engine written in TypeScript, reached by typing `psql` on a Linux host (database labs open already connected). It parses and runs a useful subset of PostgreSQL: SELECT with WHERE, ORDER BY, LIMIT, OFFSET and DISTINCT; inner, left, right, full and cross joins; GROUP BY with count/sum/avg/min/max and HAVING; subqueries in IN, EXISTS, FROM and scalar position, correlated with the outer row; UNION, INTERSECT and EXCEPT; CASE, COALESCE, NULLIF and the usual string and number functions; INSERT, UPDATE, DELETE; CREATE/ALTER/DROP TABLE with types, serial keys, NOT NULL, DEFAULT, UNIQUE, PRIMARY KEY, CHECK and REFERENCES; indexes, views, and BEGIN/COMMIT/ROLLBACK. Keys can span two columns, as a junction table needs, and a unique index refuses duplicates the way a constraint does while still letting NULLs repeat. A statement is atomic: a multi-row INSERT that breaks a constraint on its third row adds none of them, and an UPDATE does not see its own changes while it runs. Three-valued logic is honest, so `= NULL` matches nothing and `NOT IN` with a NULL returns unknown. Constraints are enforced on every write and the errors read like the server's: `duplicate key value violates unique constraint "customers_id_key"` with the offending key, a foreign key that refuses to orphan a child row, and a CHECK that names the rule it applied. `EXPLAIN` prints a plan that turns from `Seq Scan` into `Index Scan` once an index covers the column. The psql layer itself is modelled too: `dt`, `d`, `di`, `dv`, `l`, `?`, `h`, `q`, statements spanning several lines with the `shop-#` continuation prompt, command tags like `INSERT 0 1`, and results in the usual bordered table.
- **Terraform**: `terraform` is a command on a Linux workstation, reading `.tf` files from its filesystem, so configuration is written with heredocs (or pasted: the terminal runs a multi-line paste line by line) and inspected with `cat`, `ls -la .terraform` and `cat terraform.tfstate`. The HCL parser handles blocks and labels, templates and heredocs, tuples and objects, splats, for expressions, conditionals and around 90 built-in functions (`cidrsubnet`, `merge`, `templatefile`, `try`, `jsonencode` and the rest), and reports mistakes in Terraform's own boxed format with the file, line and a "Did you mean" where one fits. Configuration covers `terraform` (required_version, required_providers, backend, cloud), `provider` with aliases, `variable` with types, `optional()`, defaults, sensitivity and `validation`, `locals`, `output`, `resource`, `data` and `ephemeral` blocks with `count`, `for_each`, `depends_on`, `dynamic` blocks and `lifecycle` (create_before_destroy, prevent_destroy, ignore_changes, replace_triggered_by, preconditions and postconditions), `check`, `module` (local and versioned registry sources), `import`, `moved` and `removed`. Plans are real: every object is refreshed against the cloud, drift is reported as "Objects have changed outside of Terraform", actions follow the provider schema (update in place, or replacement marked `# forces replacement`), unknown values print `(known after apply)`, sensitive and write-only values are masked, and apply orders creates by dependency, destroys in reverse, create_before_destroy replacements with a deposed object, and removals after dependents stop using them. The CLI covers `init` (provider installation, the dependency lock file, `-upgrade`, module installation, backend migration with its prompt), `validate`, `fmt` (`-check`, `-diff`, `-recursive`), `plan` (`-out`, `-var`, `-var-file`, `-target`, `-replace`, `-destroy`, `-refresh-only`, `-generate-config-out`, `-detailed-exitcode`), `apply` (with a `yes` prompt, or a saved plan that is refused once stale), `destroy`, `refresh`, `output` (`-json`, `-raw`), `show`, `state list | show | mv | rm | pull`, `import`, `taint`/`untaint`, `workspace`, `force-unlock`, `providers`, `version`, `console`, `login`/`logout` and `-chdir`. `TF_LOG` and `TF_LOG_PATH` write debug logs that include the provider's HTTP requests and response bodies.
- **Providers and state**: `hashicorp/random`, `hashicorp/local` and the built-in `terraform_data` work as the real ones do; `netlab/netcloud` manages NetLab Cloud and changes its schema at 2.0, so an unpinned upgrade breaks a working configuration. State is version 4 JSON in the local backend (with `terraform.tfstate.backup` and per-workspace state), an http backend with locking, or HCP Terraform through the `cloud` block. Ephemeral resources and write-only arguments keep secrets out of plans and state; ordinary sensitive values are masked in output but, as in Terraform, still stored.
- **NetLab Cloud**: a fictional, vendor-neutral cloud with regions, networks, subnets, firewalls, instances, buckets and databases, and the rules that make mistakes visible: a subnet must sit inside its network and not overlap a sibling, a network or subnet still in use cannot be deleted, bucket names are global, and each region has an instance quota. The `netcloud` CLI lists, shows, resizes, tags and deletes objects, which is how changes happen outside Terraform, and `netcloud activity` shows who did what. Terraform labs show a live panel of the account that marks each object as managed by Terraform or unmanaged.
- **HCP Terraform**: `terraform login` stores a token, the `cloud` block selects workspaces by name or by project and tag, plans and applies run remotely with the workspace's own variables, and organization policy sets (hard-mandatory, soft-mandatory, advisory) check each plan before it may be applied.
- **Learning paths**: the dashboard is per path (`/paths/ccna`, `/paths/linux`, `/paths/sql`, `/paths/terraform`), with the site root given over to the home page with its own outcomes, stage navigator, unlock chain and exam blueprint. The Linux path maps modules to the five LFCS domains; Storage is reported honestly as not covered. SQL has no single vendor exam, so that path is mapped to NetLab’s own five-area syllabus and says so on the page rather than implying a blueprint that does not exist. The Terraform path is mapped to the eight Terraform Associate (004) objectives and their sub-objectives; HashiCorp publishes no weighting, so each objective's share of the sub-objectives stands in for one, and the page says so.
- **PC terminal**: `ipconfig` (with `/all`, `/renew`, `/release`), `ping` and `tracert` (IPv4 and IPv6) with Windows-style output, and `curl` (`-k`, `-u`, `-X`, `-H`, `-d`, `-i`) against a router's RESTCONF API with realistic failures (connection refused, self-signed certificate, 401, 404, 400 for malformed JSON, 204 on a successful write), so learners test from the host like they would on the job.
- **Labs with live grading**: objectives are declarative checks on device state, command history and ping results, scoped to any device in the topology. The sidebar ticks off objectives as you type.
- **Accounts**: when the site operator enables accounts (see below), learners must sign in, with email and password or GitHub, before starting a lab. Their best score and stars per lab are stored server-side and follow them across devices; the lab list and leaderboard stay visible to visitors. A copy deployed without a Supabase project runs in guest mode instead: no sign-in, progress in `localStorage`, nothing leaves the browser.
- **Leaderboard**: with accounts enabled, `/leaderboard` ranks learners by points (then labs passed, then who got there first). A lab is worth 100 points at Beginner, 200 at Intermediate and 300 at Advanced, an exam counts double, and the stars decide how much of that value is kept: all of it for a pass without hints, 70% with some, 40% after using them all (`src/lib/points.ts`). Points are stored with each passed lab so the leaderboard view can total them in SQL. Each learner has a public display name, defaulting to their GitHub user name or the part of their email before the @, editable on the account page, and can opt out of the board. Emails are never shown.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

```bash
npm test          # engine and lab tests (vitest)
npm run build     # type-check and build to dist/
```

## Accounts (optional)

NetLab works without any backend. To let learners create accounts and keep progress across devices, point it at a free [Supabase](https://supabase.com) project:

1. Create a Supabase project and apply `supabase/schema.sql`, either by pasting it into the dashboard's SQL editor or from the command line with the Supabase CLI (no database password needed, it goes through the management API after a browser login):

   ```bash
   npx supabase@2 login
   npx supabase@2 db query --linked --project-ref <your-project-ref> -f supabase/schema.sql
   ```

   It creates the `lab_progress` table (with `points` and `path` columns) and its row-level security, so each learner can only read and write their own rows, plus a `profiles` table (public display name, leaderboard opt-out, filled in automatically when an account is created) and two views: `leaderboard`, which totals points across learners without exposing anyone's individual rows, and `leaderboard_by_path`, which does the same per learning path. The file is safe to re-run after upgrades, and back-fills the new columns on rows written before they existed.
2. In Authentication > Providers, keep Email enabled. To offer the "Continue with GitHub" button as well, enable the GitHub provider, which takes an OAuth app on GitHub's side:

   1. At https://github.com/settings/developers, choose **New OAuth App**. The homepage URL is your site; the **Authorization callback URL** is Supabase's, not yours:

      ```
      https://<your-project-ref>.supabase.co/auth/v1/callback
      ```

   2. Generate a client secret, then paste the client ID and secret into Authentication > Providers > GitHub in Supabase and enable it.

   GitHub sends the learner to Supabase, which sends them on to the redirect URLs configured in the next step, so nothing else needs listing. The button is always shown; until the provider is enabled, pressing it reports that GitHub is not configured.
3. In Authentication > URL Configuration, set **Site URL** to the address learners actually use, and add every origin you sign in from under **Redirect URLs**:

   ```
   Site URL:       https://your-site.example
   Redirect URLs:  https://your-site.example/account
                   http://localhost:5173/account
   ```

   **Do this before anyone signs up.** A new project ships with `http://localhost:3000` as its Site URL, and Supabase silently falls back to the Site URL whenever a confirmation link asks to return anywhere that is not on the redirect list. A confirmation email that lands on `localhost:3000` means these two settings have not been filled in.

   Confirmation links come back to `/account` and nothing is appended to them, so one entry per origin is all it takes. Where the learner was headed is kept in their browser, not in the link. A deployment served from an origin you cannot list, such as a preview build, can set `VITE_SITE_URL` to one you can.
4. Copy the project URL and the anon (public) key from Project Settings > API into a `.env.local` file (see `.env.example`):

   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```

5. Restart `npm run dev`. A "Sign in" button appears in the header and `/account` offers sign-in and account creation.

The anon key is safe to ship in the browser bundle: every request runs under the signed-in user's JWT and the row-level security policies decide what it may touch. Terminal sessions (the text of each lab's console) stay on the device; only scores, stars and completion times are stored in the account.

## Deploying to Vercel

The app is a static site, so the free tier is enough. Import the repository in Vercel; it detects Vite and uses `npm run build` with `dist/` as the output directory. `vercel.json` rewrites every path to `index.html` so deep links like `/lab/os-01-turn-on-ospf` work on refresh. To enable accounts, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables in the project settings and redeploy. Any other static host (Netlify, Cloudflare Pages, GitHub Pages) works the same way as long as it serves `index.html` for unknown paths.

## Design

Monochrome theme: a pure black canvas, white accent and greys in between (tokens in `src/index.css`). Success, warning and danger are shades of white, so meaning always comes with an icon or a label, never from hue alone. Headings, labels, the terminal and all icons use a self-hosted [JetBrainsMono Nerd Font](https://www.nerdfonts.com/) (`public/fonts/`, WOFF2); prose uses Inter. Icons are Nerd Font glyphs rendered through `src/components/Icon.tsx`, so no icon library is needed.

## Project layout

```
src/
  engine/              Pure TypeScript, no React. Fully unit-tested.
    resolver.ts        Prefix-matching command resolver, help and Tab completion
    ios/commands.ts    Command tables per mode for switches and routers
    ios/device.ts      executeOn(network, nodeId, line); prompt(); createSwitch(); createRouter()
    ios/show.ts        Renderers for show commands, running config and show ip route
    network.ts         NetworkState (devices, hosts, links), routing tables, ping/traceroute simulation
    host.ts            PC terminal (ipconfig, ping, tracert, curl); dispatches Linux hosts to linux/
    linux/fs.ts        Linux host model: virtual filesystem, users, groups, services, processes
    linux/shell.ts     Bash-subset tokenizer, parser and interpreter
    linux/commands.ts  Linux utilities (files, text, users, systemd, apt, networking, nginx, openssl, python3 hand-off)
    linux/web.ts       shared HTTP serving: nginx parser and validator, proxying, upstreams, certificates
    linux/apache.ts    Apache parser and validator: modules, virtual hosts, TLS, proxying, balancers
    curl.ts            curl shared by PCs and Linux hosts
    restconf.ts        RESTCONF server for the ietf-interfaces and Cisco native models
    sql/               PostgreSQL-flavoured engine: parser, executor, psql layer
    terraform/hcl.ts   HCL lexer, parser and Terraform-style diagnostics
    terraform/eval.ts  Expression evaluation, unknown values, sensitivity, built-in functions
    terraform/config.ts  Loading .tf files into a module tree, decoding blocks, validate's static checks
    terraform/run.ts   The plan and apply engine: dependency graph, refresh, moves, imports, change actions, apply ordering
    terraform/providers.ts  random, local, terraform_data and netcloud, with versioned schemas
    terraform/state.ts State file format, addresses, local/http/cloud backends and locks
    terraform/project.ts  The .terraform directory, lock file, module registry, workspaces
    terraform/cli.ts   The terraform command, its prompts and TF_LOG
    terraform/cloud.ts NetLab Cloud and the netcloud CLI
    terraform/grade.ts Grading checks for Terraform labs
    grader.ts          Declarative checks and grade(objectives, network)
  content/
    labs/*.ts          Lab definitions (scenario, hints, initial device, objectives)
    blueprint.ts       CCNA 200-301 exam domains, weights, topic titles and per-domain coverage
    paths.ts           Learning paths (CCNA, Linux/LFCS, SQL, Terraform Associate) with their blueprints and outcomes
  components/, pages/  React UI (dashboard, lab page, terminal, topology)
  lib/                 progress (localStorage + optional Supabase sync), auth, per-lab session persistence, pyodide (Python runner),
                       pathProgress (lab status, next action, star levels)
supabase/schema.sql    optional database schema for accounts
```

## Writing a lab

A lab is a plain object. The starting device comes from `createSwitch()`, and objectives are lists of checks:

```ts
{
  id: 'sw-01-create-vlans',
  moduleId: 'learn-switching',
  order: 1,
  title: 'Create VLANs',
  difficulty: 'Beginner',
  estimatedMinutes: 6,
  description: 'Create and name two VLANs.',
  scenario: 'The branch office is splitting its network...',
  concepts: ['VLAN database'],
  hints: ['VLANs are created in global configuration mode with vlan 10.'],
  createState: () => createSwitch({ hostname: 'Access-SW1', ports: 6, neighbors: [...] }),
  objectives: [
    { id: 'v10', label: 'Create VLAN 10 named SALES', checks: [{ type: 'vlan-exists', id: 10, name: 'SALES' }] },
    { id: 'verify', label: 'Verify', checks: [{ type: 'command', pattern: '^(do )?show vlan brief$' }] },
  ],
}
```

Multi-device labs return a network instead of a switch:

```ts
createState: () =>
  buildNetwork({
    primary: 'R1',
    devices: [createRouter({ hostname: 'R1' }), createRouter({ hostname: 'R2', interfaces: { 'g0/1': { ipAddress: '10.0.0.2', subnetMask: '255.255.255.252', shutdown: false } } })],
    hosts: [{ id: 'PC-A', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }],
    links: [['PC-A', 'R1:g0/0'], ['R1:g0/1', 'R2:g0/1']],
  }),
```

Every check accepts an optional `device` (a device id, or a host id for `ping`); it defaults to the network's primary device. Available check types: `command` (regex over the expanded command history), `mode`, `hostname`, `vlan-exists`, `vlan-absent`, `interface`, `enable-secret`, `enable-password`, `line`, `user`, `banner`, `domain-name`, `ssh-ready`, `default-gateway`, `saved`, `password-encryption`, `error-seen`, `ping`, `route`, `route-absent`, `learned-route`, `ospf`, `ospf-network`, `ospf-network-absent`, `ospf-neighbors`, `passive-interface`, `default-information-originate`, `trunk-allows`, `acl-exists`, `acl-entry`, `acl-applied`, `acl-not-applied`, `access-class`, `dhcp-pool`, `dhcp-excluded`, `dhcp-bindings`, `helper-address`, `host-config`, `nat-role`, `nat-static`, `nat-pool`, `nat-dynamic`, `nat-translations`, `ipv6-unicast-routing`, `ipv6-address`, `route6`, `etherchannel`, `port-security`, `stp-root`, `stp-priority`, `stp-mode`, `stp-port`, `password-policy`, `exec-timeout`, `aaa`, `dhcp-snooping`, `port-trust`, `arp-inspection`, `management-api`, `api-request`, `syslog`, `snmp-community`, `ntp-server`. Linux hosts (`device` = host id): `file` (exists, kind, contains, mode, owner, group, target, executable), `linux-user`, `linux-group`, `service`, `package`, `linux-hostname`, `shell-output` (regex over what the learner saw), `python-run` (a script ran, its exit code, a regex over its stdout), `process`, `web-request` (scheme, Host, path, status and which backend answered), `nginx-config` (the configuration on disk passes or fails `nginx -t`), `apache-config` (passes or fails `apache2ctl configtest`), `apache-module` and `apache-site` (enabled by `a2enmod` / `a2ensite`). `web-request` also records which server answered (`engine`). SQL labs (`device` = the host holding the database): `sql-table` (a table exists with these columns, types, keys and constraints, this many rows, and these columns absent), `sql-query` (the grader runs its own query and compares the rows), `sql-answer` (the learner ran *some* query that returned the right answer, worked out by running the reference query, optionally order-sensitive), `sql-ran` (regex over the statements that actually ran), `sql-index`, `sql-view`, `sql-result` (what the learner's last query returned). A statement the server refused is never recorded as having run, so proving a learner saw a constraint fire uses `shell-output` against the error text. Terraform labs (`device` = the workstation; `dir` defaults to `~/infra`): `tf-ran` (a terraform command ran, with its exit code, a regex over its arguments, and the counts it added, changed, destroyed or imported), `tf-resource` (an address in state, read through whichever backend is configured, with attribute values), `tf-state-count`, `tf-output`, `tf-lock` (the lock file's selected version and constraints), `tf-module`, `tf-backend`, `tf-workspace`, `tf-parses`, `tf-formatted`, `tf-config` (a regex over the `.tf` files, or its absence), `tf-converged` (the grader runs a plan and passes when nothing would change), `cloud-object` (objects in the cloud account by kind, name, region and attributes), `tf-remote-lock` and `hcp-workspace`. See `src/engine/grader.ts` and `src/engine/terraform/grade.ts`.

Add the lab to a module file in `src/content/labs/` and add a reference solution to `src/engine/grader.test.ts` so it stays green. A new module also needs a `pathId` and `examTopics` (topic codes such as `'3.4'` for CCNA or `'EC.2'` for Linux) in `src/content/index.ts`; any code not yet described in the path's blueprint (`src/content/blueprint.ts` or `src/content/paths.ts`) must be added there, and the blueprint test enforces both. A Linux lab builds its host with `linux: { hostname, users, groups, files, services, packages, processes }` on a host in `buildNetwork` (see `src/content/labs/linux-site.ts`). A SQL lab uses `sqlSite()` from `src/content/labs/sql-site.ts`, which stands up PostgreSQL on `db1` from a `setup` script of real SQL and opens the terminal at the psql prompt; pass `atShell: true` to start in the shell instead. A Terraform lab uses `tfSite()` from `src/content/labs/tf-site.ts`: `files` for the starting configuration, `cloud` for objects that already exist, `prepare` for real terraform commands run before the learner arrives (so state and lock files are genuine), `edits` for a colleague's later changes, and `after` for anything done outside Terraform, such as a resize or a stale lock.

## Roadmap

- [x] Router model: routed interfaces, static routes, `show ip route`, inter-VLAN routing
- [x] Multi-device labs with a PC terminal and frame forwarding between devices
- [x] Single-area OSPF
- [x] Access control lists enforced in the forwarding simulation
- [x] DHCP server and relay
- [x] NAT (static, dynamic, PAT) and IPv6 addressing with static routing
- [x] EtherChannel (LACP, PAgP, static) and port security
- [x] Multi-area OSPF and per-VLAN spanning tree (root election, blocked ports, PortFast, BPDU guard)
- [x] Network security: password policy, AAA, DHCP snooping and dynamic ARP inspection enforced in the simulation
- [x] Automation: RESTCONF and NETCONF enablement, `curl` from the PC against a simulated RESTCONF API, syslog/SNMP/NTP telemetry
- [x] Linux path: Bash-subset shell, virtual filesystem with permissions, users, sudo, systemd, apt, processes and networking from the host
- [x] Python on Linux through Pyodide, with files, stdout and exit codes flowing back into the shell
- [x] SQL path: a PostgreSQL-flavoured engine with a hand-written parser, joins, aggregation, subqueries, constraints, transactions, indexes and views, behind a real psql prompt
- [x] Terraform path: HCL, plan and apply, providers and the lock file, modules, state backends and locking, drift, import, workspaces, verbose logging and HCP Terraform against a simulated vendor-neutral cloud
- [ ] Terraform: `for_each` and `count` on module blocks, provider-defined functions, `terraform test`, template directives
- [ ] OSPFv3, SLAAC and DHCPv6, IPv6 access lists
- [x] Web servers: nginx virtual hosts, self-signed TLS, HTTP-to-HTTPS redirects, reverse proxy and load balancing with failover
- [ ] Linux storage domain (lsblk, mount, fstab, LVM), cron, tar and compression, ufw, SSH key management
- [x] Apache: the Debian layout, a2enmod/a2ensite, module-gated directives, TLS, reverse proxy and mod_proxy_balancer, and port-bind conflicts between two servers
- [ ] nginx and Apache access and error logs written as requests are served, rate limiting, gzip and caching
- [ ] Basic authentication (htpasswd), .htaccess, and PHP-FPM behind both servers
- [ ] A second Linux host per lab and ssh between hosts
- [ ] ARP access lists for DAI, DHCP snooping rate limits with err-disable, 802.1X port authentication
- [ ] NETCONF sessions from the PC, RESTCONF for ACLs and routes, a sandbox JSON viewer
- [ ] Layer 3 EtherChannel, MST, route summarisation on ABRs
- [ ] More vendors through the adapter pattern (JunOS, Arista EOS, Aruba CX)
- [ ] Sandbox topology editor
- [ ] Markdown lab format and a lab authoring page
- [ ] Optional export/import of progress as a file

## Contributing

Issues and pull requests are welcome. Keep the engine free of React, add tests for any new command, and write original lab text.

## License

MIT. Cisco and IOS are trademarks of Cisco Systems, Inc. HashiCorp, Terraform and HCP Terraform are trademarks of HashiCorp, an IBM company. NetLab is an independent educational simulator and is not affiliated with or endorsed by Cisco or HashiCorp. NetLab Cloud is fictional.
