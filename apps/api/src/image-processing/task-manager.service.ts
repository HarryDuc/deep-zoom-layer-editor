import { Injectable, Logger } from '@nestjs/common';

export interface TaskHandle {
  id: string;
  promise: Promise<void>;
}

interface QueueEntry {
  id: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * A deliberately small in-process task runner used only by the image
 * processing pipeline.
 *
 * It is NOT a durable queue: tasks live in memory and are lost if the process
 * exits. See `ImageProcessingService.recoverInterruptedAssets()` for how stale
 * `PROCESSING` records are reconciled on startup.
 *
 * Responsibilities kept intentionally narrow:
 *  - bound the number of concurrently running tasks,
 *  - reject duplicate submissions for the same id,
 *  - serialize submissions per id.
 */
@Injectable()
export class TaskManagerService {
  private readonly logger = new Logger(TaskManagerService.name);
  private readonly pending: QueueEntry[] = [];
  private readonly active = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Task concurrency must be an integer greater than 0');
    }
  }

  get concurrencyLimit(): number {
    return this.concurrency;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  isScheduled(id: string): boolean {
    return this.inFlight.has(id);
  }

  /**
   * Enqueues `run` unless a task with the same `id` is already scheduled or
   * running. Returns the existing promise for duplicate submissions so callers
   * can await the same work instead of starting a second job.
   */
  submit(id: string, run: () => Promise<void>): TaskHandle {
    const existing = this.inFlight.get(id);
    if (existing) {
      this.logger.debug(`Task ${id} is already scheduled; reusing existing handle`);
      return { id, promise: existing };
    }

    let resolveFn!: () => void;
    let rejectFn!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.inFlight.set(id, promise);
    this.pending.push({ id, run, resolve: resolveFn, reject: rejectFn });
    this.drain();

    return { id, promise };
  }

  /** Resolves once every queued and active task has settled. Test helper. */
  async onIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  private drain(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) return;
      void this.execute(entry);
    }
  }

  private async execute(entry: QueueEntry): Promise<void> {
    this.active.add(entry.id);
    try {
      await entry.run();
      entry.resolve();
    } catch (error) {
      entry.reject(error);
    } finally {
      this.active.delete(entry.id);
      this.inFlight.delete(entry.id);
      this.drain();
    }
  }
}
