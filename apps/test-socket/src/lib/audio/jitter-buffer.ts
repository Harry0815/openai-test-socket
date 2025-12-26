import { EventEmitter } from 'events';

export interface JitterBufferOptions {
  targetLatencyMs?: number;
  maxLatencyMs?: number;
  flushIntervalMs?: number;
}

type JitterChunk = {
  receivedAt: number;
  data: Buffer;
};

export class JitterBuffer extends EventEmitter {
  private readonly targetLatencyMs: number;
  private readonly maxLatencyMs: number;
  private readonly flushIntervalMs: number;
  private queue: JitterChunk[] = [];
  private timer?: NodeJS.Timeout;

  constructor(options: JitterBufferOptions = {}) {
    super();
    this.targetLatencyMs = options.targetLatencyMs ?? 40;
    this.maxLatencyMs = options.maxLatencyMs ?? 200;
    this.flushIntervalMs = options.flushIntervalMs ?? 10;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  write(data: Buffer): void {
    this.queue.push({ data, receivedAt: Date.now() });
    this.trim();
  }

  end(): void {
    this.flush(true);
    this.stop();
    this.emit('end');
  }

  private flush(force = false): void {
    const now = Date.now();

    while (this.queue.length > 0) {
      const item = this.queue[0];
      if (!force && now - item.receivedAt < this.targetLatencyMs) {
        break;
      }

      this.queue.shift();
      this.emit('data', item.data);
    }
  }

  private trim(): void {
    const now = Date.now();

    while (this.queue.length > 0 && now - this.queue[0].receivedAt > this.maxLatencyMs) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.emit('drop', dropped.data);
      }
    }
  }
}
