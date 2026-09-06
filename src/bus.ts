import { EventEmitter } from 'node:events';
import { config } from './config.js';
import type { ExternalEvent, Escalation, Message, Run, RunEvent, Thread } from './types.js';

export type BusEvent =
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'message.created'; message: Message }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.event'; event: RunEvent }
  | { type: 'escalation.updated'; escalation: Escalation }
  | { type: 'external.event'; event: ExternalEvent }
  | { type: 'orchestrator.state'; threadId: string; buffered: number; activeRunId: string | null };

class Bus extends EventEmitter {
  /** кольцевой буфер последних внешних событий — отдаётся UI при подключении */
  readonly externalRing: ExternalEvent[] = [];
  /** последние события оркестрации, чтобы вкладка сразу что-то показывала */
  readonly runEventRing: RunEvent[] = [];

  publish(event: BusEvent): void {
    if (event.type === 'external.event') {
      this.externalRing.unshift(event.event);
      if (this.externalRing.length > config.logRetentionEvents) this.externalRing.length = config.logRetentionEvents;
    }
    if (event.type === 'run.event') {
      this.runEventRing.unshift(event.event);
      if (this.runEventRing.length > config.logRetentionEvents) this.runEventRing.length = config.logRetentionEvents;
    }
    this.emit('event', event);
  }

  subscribe(handler: (event: BusEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
}

export const bus = new Bus();
bus.setMaxListeners(200);
