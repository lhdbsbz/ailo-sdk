import type { DesktopActionResult, DesktopObservation, DesktopVerdict } from "./desktop_types.js";

const DEFAULT_OBSERVATION_TTL_MS = 60_000;
const MAX_OBSERVATIONS = 20;

export class DesktopStateStore {
  private readonly observations = new Map<string, DesktopObservation>();
  private lastObservationId: string | null = null;
  private lastAction: DesktopActionResult | null = null;
  private lastVerdict: DesktopVerdict | null = null;

  constructor(private readonly observationTtlMs = DEFAULT_OBSERVATION_TTL_MS) {}

  saveObservation(observation: DesktopObservation): void {
    this.pruneExpired();
    this.observations.set(observation.id, observation);
    this.lastObservationId = observation.id;
    while (this.observations.size > MAX_OBSERVATIONS) {
      const oldestKey = this.observations.keys().next().value;
      if (!oldestKey) break;
      this.observations.delete(oldestKey);
    }
  }

  getObservation(id: string): DesktopObservation | null {
    this.pruneExpired();
    return this.observations.get(id) ?? null;
  }

  getLatestObservation(): DesktopObservation | null {
    this.pruneExpired();
    if (!this.lastObservationId) return null;
    return this.observations.get(this.lastObservationId) ?? null;
  }

  isExpired(observation: DesktopObservation): boolean {
    return Date.now() - observation.timestamp > this.observationTtlMs;
  }

  setLastAction(action: DesktopActionResult): void {
    this.lastAction = action;
  }

  getLastAction(): DesktopActionResult | null {
    return this.lastAction;
  }

  setLastVerdict(verdict: DesktopVerdict): void {
    this.lastVerdict = verdict;
  }

  getLastVerdict(): DesktopVerdict | null {
    return this.lastVerdict;
  }

  private pruneExpired(): void {
    for (const [id, observation] of this.observations) {
      if (this.isExpired(observation)) this.observations.delete(id);
    }
    if (this.lastObservationId && !this.observations.has(this.lastObservationId)) {
      this.lastObservationId = null;
    }
  }
}
