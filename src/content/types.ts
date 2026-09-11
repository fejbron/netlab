import type { DeviceState, NetworkState, Objective } from '../engine';

export type Difficulty = 'Beginner' | 'Intermediate' | 'Advanced';

export interface Module {
  id: string;
  /** Learning path this module belongs to (see content/paths.ts). */
  pathId: string;
  order: number;
  title: string;
  description: string;
  /** 200-301 CCNA blueprint topic codes this module practises, e.g. ['2.1', '2.2']. See content/blueprint.ts. */
  examTopics?: string[];
}

export interface Lab {
  id: string;
  moduleId: string;
  order: number;
  title: string;
  difficulty: Difficulty;
  estimatedMinutes: number;
  /** One-line summary shown on the dashboard. */
  description: string;
  /** Story shown in the lab. Blank lines separate paragraphs. */
  scenario: string;
  concepts: string[];
  /** Progressive hints, revealed one at a time. Empty for exams. */
  hints: string[];
  /**
   * Builds the starting topology. Called on every reset. A bare switch (with
   * `neighbors`) is wrapped into a one-device network automatically.
   */
  createState: () => DeviceState | NetworkState;
  objectives: Objective[];
  isExam?: boolean;
}
