/**
 * EventBus — Type-safe pub/sub event system.
 */

type Listener<T = unknown> = (data: T) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  on<T>(event: string, listener: Listener<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as Listener);

    return () => this.off(event, listener);
  }

  off<T>(event: string, listener: Listener<T>): void {
    this.listeners.get(event)?.delete(listener as Listener);
  }

  emit<T>(event: string, data: T): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(data);
      } catch (err) {
        // Isolate listener errors so remaining listeners still fire
        console.error(`[EventBus] Listener error on "${event}":`, err);
      }
    }
  }

  once<T>(event: string, listener: Listener<T>): () => void {
    const wrapper: Listener<T> = (data) => {
      this.off(event, wrapper);
      listener(data);
    };
    return this.on(event, wrapper);
  }

  clear(): void {
    this.listeners.clear();
  }
}
