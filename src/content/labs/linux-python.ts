import type { Lab } from '../types';
import { INTENT_JSON, linuxSite } from './linux-site';

const MODULE = 'linux-python';
const W = 'web1';

export const linuxPythonLabs: Lab[] = [
  {
    id: 'lx-20-hello-python',
    moduleId: MODULE,
    order: 1,
    title: 'Hello, Python',
    difficulty: 'Beginner',
    estimatedMinutes: 6,
    description: 'Run Python one-liners and your first script. Real CPython runs in your browser.',
    scenario:
      'web1 has Python 3. Check the version with python3 --version, then run a one-liner: python3 -c \'print("Hello from Python")\'.\n\nWrite hello.py with a heredoc: set name = "NetLab" and print f"Hello, {name}!". Run it with python3 hello.py. The first run downloads the interpreter (about 10 MB) and takes a few seconds; later runs are instant.',
    concepts: ['python3 -c', 'Scripts and python3 file.py', 'print and f-strings', 'Variables'],
    hints: ['python3 --version, then python3 -c \'print("Hello from Python")\'.', "cat > hello.py << 'EOF' … name = \"NetLab\" … print(f\"Hello, {name}!\") … EOF", 'python3 hello.py'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'version', label: 'Check the Python version', checks: [{ type: 'command', device: W, pattern: '^python3? (--version|-V)$' }] },
      { id: 'oneliner', label: 'Run a one-liner', checks: [{ type: 'python-run', device: W, pattern: '^Hello from Python$', label: 'python3 -c printed Hello from Python' }] },
      { id: 'script', label: 'Write and run hello.py', checks: [{ type: 'file', device: W, path: '~/hello.py', contains: 'print\\(' }, { type: 'python-run', device: W, file: 'hello.py', pattern: '^Hello, NetLab!$' }] },
    ],
  },
  {
    id: 'lx-21-read-files-with-python',
    moduleId: MODULE,
    order: 2,
    title: 'Read Files With Python',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Open a log, keep the ERROR lines, count them, and write a summary file.',
    scenario:
      'Write errors.py. Open /var/log/app.log, collect every line that contains "ERROR", print "<n> errors" (so "2 errors"), and write the collected lines to ~/summary.txt, one per line. Run it and cat the summary.',
    concepts: ['open() and with', 'Iterating over lines', 'Lists and len()', 'Writing files'],
    hints: ['with open("/var/log/app.log") as f: for line in f: if "ERROR" in line: errors.append(line.rstrip())', 'print(f"{len(errors)} errors")', 'with open("summary.txt", "w") as out: out.write("\\n".join(errors) + "\\n")'],
    createState: () => linuxSite(),
    objectives: [
      { id: 'script', label: 'errors.py opens the log and filters ERROR', checks: [{ type: 'file', device: W, path: '~/errors.py', contains: 'open\\(' }, { type: 'file', device: W, path: '~/errors.py', contains: 'ERROR' }] },
      { id: 'run', label: 'It prints the count', checks: [{ type: 'python-run', device: W, file: 'errors.py', pattern: '^2 errors$' }] },
      { id: 'summary', label: 'summary.txt holds the error lines', checks: [{ type: 'file', device: W, path: '~/summary.txt', contains: 'ERROR disk full' }, { type: 'file', device: W, path: '~/summary.txt', contains: 'ERROR timeout' }] },
    ],
  },
  {
    id: 'lx-22-read-json-with-python',
    moduleId: MODULE,
    order: 3,
    title: 'Read JSON With Python',
    difficulty: 'Intermediate',
    estimatedMinutes: 10,
    description: 'Load a network intent file with the json module and walk its objects and arrays.',
    scenario:
      '~/intent.json describes a router the automation team wants to build (cat it first). Write intent.py that loads it with json.load, prints the hostname from the "device" object, and then prints one line per entry in "interfaces": the interface name and its IPv4 address separated by a space.',
    concepts: ['import json and json.load', 'Dictionaries and keys', 'Lists and for loops', 'Nested data'],
    hints: ['with open("intent.json") as f: intent = json.load(f)', 'print(intent["device"]["hostname"])', 'for iface in intent["interfaces"]: print(iface["name"], iface["ipv4"]["ip"])'],
    createState: () => linuxSite({ files: { '~/intent.json': INTENT_JSON } }),
    objectives: [
      { id: 'look', label: 'Look at the intent file', checks: [{ type: 'command', device: W, pattern: '^(cat|less|jq|python3 -m json\\.tool)\\b.*intent\\.json' }] },
      { id: 'script', label: 'intent.py uses the json module', checks: [{ type: 'file', device: W, path: '~/intent.py', contains: 'import json' }, { type: 'file', device: W, path: '~/intent.py', contains: 'json\\.load' }] },
      { id: 'run', label: 'It prints the hostname and the interfaces', checks: [{ type: 'python-run', device: W, file: 'intent.py', pattern: '^Site2-R2$' }, { type: 'python-run', device: W, file: 'intent.py', pattern: '^GigabitEthernet0/0 192\\.168\\.2\\.1$' }, { type: 'python-run', device: W, file: 'intent.py', pattern: '^GigabitEthernet0/1 10\\.0\\.0\\.2$' }] },
    ],
  },
  {
    id: 'lx-23-generate-config-from-json',
    moduleId: MODULE,
    order: 4,
    title: 'Generate Configuration From JSON',
    difficulty: 'Intermediate',
    estimatedMinutes: 12,
    description: 'Turn the intent file into a Cisco IOS configuration file with Python.',
    scenario:
      'Write render.py that reads ~/intent.json and writes ~/r2.cfg containing IOS configuration: hostname <name>; for each interface an interface block with description, ip address <ip> <netmask> and no shutdown; ip route <prefix> <netmask> <next-hop> for each static route; and ntp server <address> for each NTP server. Run it and cat r2.cfg.',
    concepts: ['Building text from data', 'f-strings and join', 'Writing a file', 'Templates versus hand-typed configuration'],
    hints: ['lines = [f"hostname {intent[\'device\'][\'hostname\']}"]', 'for i in intent["interfaces"]: lines += [f"interface {i[\'name\']}", f" description {i[\'description\']}", f" ip address {i[\'ipv4\'][\'ip\']} {i[\'ipv4\'][\'netmask\']}", " no shutdown"]', 'for r in intent["static-routes"]: lines.append(f"ip route {r[\'prefix\']} {r[\'netmask\']} {r[\'next-hop\']}"); then open("r2.cfg", "w").write("\\n".join(lines) + "\\n")'],
    createState: () => linuxSite({ files: { '~/intent.json': INTENT_JSON } }),
    objectives: [
      { id: 'script', label: 'render.py reads JSON and writes a file', checks: [{ type: 'file', device: W, path: '~/render.py', contains: 'json' }, { type: 'file', device: W, path: '~/render.py', contains: '"w"|\'w\'' }] },
      { id: 'run', label: 'It runs cleanly', checks: [{ type: 'python-run', device: W, file: 'render.py' }] },
      { id: 'cfg', label: 'r2.cfg holds the rendered configuration', checks: [{ type: 'file', device: W, path: '~/r2.cfg', contains: '^hostname Site2-R2$' }, { type: 'file', device: W, path: '~/r2.cfg', contains: '^interface GigabitEthernet0/0$' }, { type: 'file', device: W, path: '~/r2.cfg', contains: '^ ip address 192\\.168\\.2\\.1 255\\.255\\.255\\.0$' }, { type: 'file', device: W, path: '~/r2.cfg', contains: '^ip route 192\\.168\\.1\\.0 255\\.255\\.255\\.0 10\\.0\\.0\\.1$' }, { type: 'file', device: W, path: '~/r2.cfg', contains: '^ntp server 192\\.168\\.1\\.50$' }] },
    ],
  },
  {
    id: 'lx-24-exam-audit-the-server',
    moduleId: MODULE,
    order: 5,
    title: 'Exam: Audit the Server',
    difficulty: 'Advanced',
    estimatedMinutes: 20,
    description: 'Write a Python audit that reads system files and produces CSV and JSON reports.',
    scenario:
      'Write ~/audit.py. It reads /etc/passwd and collects every account with a UID of 1000 or more whose shell is not nologin, then writes ~/users.csv with a line per account in the form name,uid,shell. It counts the "Failed password" lines in /var/log/auth.log and prints "<n> failed logins". Finally it writes ~/audit.json containing an object with "users" (the list of account names) and "failed_logins" (the count). Run it.',
    concepts: ['Synthesis', 'Parsing colon-separated text', 'Filtering with conditions', 'Writing CSV and JSON'],
    hints: [],
    isExam: true,
    createState: () => linuxSite({ users: [{ name: 'bob' }] }),
    objectives: [
      { id: 'script', label: 'audit.py reads passwd and the auth log', checks: [{ type: 'file', device: W, path: '~/audit.py', contains: '/etc/passwd' }, { type: 'file', device: W, path: '~/audit.py', contains: 'auth\\.log' }, { type: 'file', device: W, path: '~/audit.py', contains: 'import json' }] },
      { id: 'run', label: 'It prints the failed login count', checks: [{ type: 'python-run', device: W, file: 'audit.py', pattern: '^4 failed logins$' }] },
      { id: 'csv', label: 'users.csv lists the interactive accounts', checks: [{ type: 'file', device: W, path: '~/users.csv', contains: '^student,1000,/bin/bash$' }, { type: 'file', device: W, path: '~/users.csv', contains: '^bob,1001,/bin/bash$' }, { type: 'file', device: W, path: '~/users.csv', notContains: 'nobody|root', label: 'No system accounts' }] },
      { id: 'json', label: 'audit.json holds the summary', checks: [{ type: 'file', device: W, path: '~/audit.json', contains: '"failed_logins": 4' }, { type: 'file', device: W, path: '~/audit.json', contains: '"student"' }] },
    ],
  },
];
