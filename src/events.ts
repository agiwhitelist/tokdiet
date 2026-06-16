// src/events.ts — in-process event bus that drives the live dashboard via SSE.
import type { EventBus, GovernorEvent } from './types.js';

/**
 * Synchronous, fan-out event bus held in memory.
 *
 * Listeners are stored in a Set so duplicate registrations collapse and
 * unsubscription is O(1). Each listener is invoked inside its own try/catch so
 * a throwing listener can never prevent the remaining listeners from receiving
 * the event (fail-isolated delivery).
 */
export class InProcessEventBus implements EventBus {
  private readonly listeners = new Set<(e: GovernorEvent) => void>();

  /** Deliver an event to every current subscriber; isolate listener failures. */
  emit(e: GovernorEvent): void {
    // Snapshot so listeners that (un)subscribe during delivery don't disturb iteration.
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        // A misbehaving listener must not break delivery to the others.
      }
    }
  }

  /** Register a listener; returns an idempotent unsubscribe function. */
  subscribe(fn: (e: GovernorEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
