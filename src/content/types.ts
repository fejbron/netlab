import type { DeviceState, Objective } from '../engine';

export type Difficulty = 'Beginner' | 'Intermediate' | 'Advanced';

export interface Module {
  id: string;
  order: number;
  title: string;
  description: string;
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
  /** Builds the starting device. Called on every reset. */
  createState: () => DeviceState;
  objectives: Objective[];
  isExam?: boolean;
}
