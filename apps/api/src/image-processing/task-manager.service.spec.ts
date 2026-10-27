import { TaskManagerService } from './task-manager.service';

/** Resolves after `ms` so we can observe queue ordering. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TaskManagerService', () => {
  it('rejects a non-positive concurrency limit', () => {
    expect(() => new TaskManagerService(0)).toThrow(/greater than 0/);
    expect(() => new TaskManagerService(1.5)).toThrow(/greater than 0/);
  });

  it('never runs more tasks than the configured limit', async () => {
    const manager = new TaskManagerService(2);
    let running = 0;
    let peak = 0;

    const task = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(20);
      running -= 1;
    };

    for (let index = 0; index < 6; index += 1) {
      manager.submit(`task-${index}`, task);
    }

    expect(manager.pendingCount).toBe(4);
    expect(manager.activeCount).toBe(2);

    await manager.onIdle();

    expect(peak).toBe(2);
    expect(manager.activeCount).toBe(0);
    expect(manager.pendingCount).toBe(0);
  });

  it('reuses the in-flight promise for a duplicate id instead of running twice', async () => {
    const manager = new TaskManagerService(1);
    const run = jest.fn(async (): Promise<void> => {
      await delay(10);
    });

    const first = manager.submit('dup', run);
    const second = manager.submit('dup', run);

    expect(manager.isScheduled('dup')).toBe(true);

    await Promise.all([first.promise, second.promise]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.isScheduled('dup')).toBe(false);
  });

  it('propagates task failures to the caller and frees the slot', async () => {
    const manager = new TaskManagerService(1);

    const failing = manager.submit('fail', async () => {
      throw new Error('boom');
    });

    await expect(failing.promise).rejects.toThrow('boom');

    // The queue must continue draining after a failure.
    const ok = jest.fn(async (): Promise<void> => undefined);
    await manager.submit('ok', ok).promise;
    expect(ok).toHaveBeenCalledTimes(1);
    expect(manager.activeCount).toBe(0);
  });

  it('allows a new submission for the same id after the first one settles', async () => {
    const manager = new TaskManagerService(1);
    const run = jest.fn(async (): Promise<void> => undefined);

    await manager.submit('repeat', run).promise;
    await manager.submit('repeat', run).promise;

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('onIdle resolves immediately when nothing is queued', async () => {
    const manager = new TaskManagerService(2);
    await expect(manager.onIdle()).resolves.toBeUndefined();
  });
});
