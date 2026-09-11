import type { Lab, Module } from './types';

/**
 * Cisco 200-301 CCNA v1.1 exam blueprint: the six published domains with their
 * weighting, and the individual topics NetLab modules practise. Cisco may revise
 * the blueprint at any time; the version and review date are shown to learners.
 */
export const BLUEPRINT = {
  examCode: '200-301',
  version: '200-301 CCNA v1.1',
  reviewedAt: '2026-09-11',
  facts: [
    { label: 'Exam code', value: '200-301' },
    { label: 'Blueprint', value: 'v1.1' },
    { label: 'Duration', value: '120 min' },
    { label: 'Domains', value: '6' },
  ],
  sources: [
    { label: 'Official exam topics', url: 'https://learningnetwork.cisco.com/s/ccna-exam-topics' },
    { label: 'Cisco exam overview', url: 'https://www.cisco.com/site/us/en/learn/training-certifications/exams/ccna.html' },
  ],
  weightingNote: 'The six percentages reproduce Cisco’s published 200-301 CCNA v1.1 exam-domain weighting. Cisco notes that exam guidelines may change without notice.',
  trademarkNotice:
    'NetLab is an independent, open-source simulator and is not affiliated with, authorized, sponsored, or endorsed by Cisco. Cisco® and CCNA® are registered trademarks of Cisco and/or its affiliates. The labs are original and are not official Cisco training or a guarantee of exam readiness.',
} as const;

export interface ExamDomain {
  /** '1' … '6', the blueprint's own numbering. */
  id: string;
  title: string;
  /** Percentage of the exam. */
  weight: number;
}

export const EXAM_DOMAINS: ExamDomain[] = [
  { id: '1', title: 'Network Fundamentals', weight: 20 },
  { id: '2', title: 'Network Access', weight: 20 },
  { id: '3', title: 'IP Connectivity', weight: 25 },
  { id: '4', title: 'IP Services', weight: 10 },
  { id: '5', title: 'Security Fundamentals', weight: 15 },
  { id: '6', title: 'Automation and Programmability', weight: 10 },
];

/** Blueprint topics referenced by at least one module, keyed by their code ("2.1"). */
export const EXAM_TOPICS: Record<string, string> = {
  '1.1': 'Explain the role and function of network components',
  '1.6': 'Configure and verify IPv4 addressing and subnetting',
  '1.8': 'Configure and verify IPv6 addressing and prefix',
  '1.9': 'Describe IPv6 address types',
  '1.10': 'Verify IP parameters for a client OS',
  '1.13': 'Describe switching concepts (MAC learning, aging, frame switching, flooding, MAC table)',
  '2.1': 'Configure and verify VLANs spanning multiple switches',
  '2.2': 'Configure and verify interswitch connectivity (trunk ports, 802.1Q, native VLAN)',
  '2.4': 'Configure and verify Layer 2/Layer 3 EtherChannel (LACP)',
  '2.5': 'Interpret basic operations of Rapid PVST+ Spanning Tree Protocol',
  '3.1': 'Interpret the components of a routing table',
  '3.2': 'Determine how a router makes a forwarding decision by default',
  '3.3': 'Configure and verify IPv4 and IPv6 static routing',
  '3.4': 'Configure and verify single area OSPFv2',
  '4.1': 'Configure and verify inside source NAT using static and pools',
  '4.3': 'Explain the role of DHCP and DNS within the network',
  '4.6': 'Configure and verify DHCP client and relay',
  '4.8': 'Configure network devices for remote access using SSH',
  '5.3': 'Configure and verify device access control using local passwords',
  '5.6': 'Configure and verify access control lists',
  '5.7': 'Configure and verify Layer 2 security features (port security)',
};

/** Domain a topic code belongs to ("3.4" → domain "3"). */
export function topicDomain(code: string): string {
  return code.split('.')[0];
}

/** What the CCNA path promises, shown on the dashboard. */
export const PATH_OVERVIEW = {
  title: 'CCNA Network Operator',
  scopeLabel: 'Cisco certification path',
  levelLabel: 'Associate',
  summary: 'Learn Cisco IOS as you configure, secure, and troubleshoot a small campus network.',
  outcomes: [
    'Operate Cisco IOS confidently and preserve a verified device configuration.',
    'Build and troubleshoot VLAN, trunk, EtherChannel, spanning-tree, IPv4, IPv6 and OSPF workflows.',
    'Filter traffic with access lists, hand out addresses with DHCP, publish services with NAT, and harden device access.',
    'Diagnose a broken network from show output and pings, then fix the right device with the smallest change.',
  ],
  audience: 'New network operators and support engineers preparing for practical CCNA-level work.',
  prerequisites: 'No prior networking experience required. Basic computer and IP-address familiarity is useful but not required.',
  skillTags: ['Cisco IOS', 'Switching', 'Routing', 'Security', 'Troubleshooting'],
} as const;

export interface DomainCoverage extends ExamDomain {
  /** Topic codes practised in at least one module. */
  topics: string[];
  modules: Module[];
  labs: number;
  completed: number;
  /** 0-100 of the domain's labs passed; 0 when the domain has no labs. */
  percent: number;
}

/** Per-domain lab counts and learner progress, from the modules' topic lists. */
export function domainCoverage(modules: Module[], labs: Lab[], progress: Record<string, unknown>): DomainCoverage[] {
  return EXAM_DOMAINS.map((d) => {
    const mods = modules.filter((m) => (m.examTopics ?? []).some((t) => topicDomain(t) === d.id));
    const topics = [...new Set(mods.flatMap((m) => m.examTopics ?? []).filter((t) => topicDomain(t) === d.id))].sort(byTopicCode);
    const ids = new Set(mods.map((m) => m.id));
    const domainLabs = labs.filter((l) => ids.has(l.moduleId));
    const completed = domainLabs.filter((l) => progress[l.id]).length;
    return { ...d, topics, modules: mods, labs: domainLabs.length, completed, percent: domainLabs.length ? Math.round((completed / domainLabs.length) * 100) : 0 };
  });
}

/** "1.13" sorts after "1.6" (numeric, not lexical). */
export function byTopicCode(a: string, b: string): number {
  const [ad, at] = a.split('.').map(Number);
  const [bd, bt] = b.split('.').map(Number);
  return ad - bd || at - bt;
}
