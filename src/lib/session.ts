import type { DeviceState } from '../engine';

export type TermLine = { kind: 'input'; prompt: string; text: string } | { kind: 'output'; text: string };

export interface LabSession {
  state: DeviceState;
  lines: TermLine[];
  hintsRevealed: number;
}

const key = (labId: string) => `netlab-session-${labId}`;

export function loadSession(labId: string): LabSession | null {
  try {
    const raw = localStorage.getItem(key(labId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LabSession;
    if (!parsed.state || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(labId: string, session: LabSession) {
  try {
    localStorage.setItem(key(labId), JSON.stringify(session));
  } catch {
    /* storage unavailable */
  }
}

export function clearSession(labId: string) {
  try {
    localStorage.removeItem(key(labId));
  } catch {
    /* storage unavailable */
  }
}
