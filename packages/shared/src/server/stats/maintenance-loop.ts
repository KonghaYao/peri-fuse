/** A maintenance pass schedules its successor only after it finishes. Stop cancels future work. */
export function startMaintenanceLoop(
  initial: (signal: AbortSignal) => Promise<unknown>,
  refresh: (signal: AbortSignal) => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (pass: (signal: AbortSignal) => Promise<unknown>) => {
    try {
      await pass(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      if (!controller.signal.aborted) {
        timer = setTimeout(() => void run(refresh), intervalMs);
        timer.unref?.();
      }
    }
  };
  void run(initial);
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
