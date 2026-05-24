// Single-trailing-edge debounce. `fn` fires `delay` ms after the LAST call.
// Calls within the window reset the timer; the most recent arguments win.
// `.cancel()` aborts a pending fire.

export interface Debounced<Args extends unknown[]> {
  (...args: Args): void;
  cancel(): void;
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number,
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  const debounced = ((...args: Args) => {
    pendingArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = pendingArgs!;
      pendingArgs = null;
      fn(...a);
    }, delay);
  }) as Debounced<Args>;

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      pendingArgs = null;
    }
  };

  return debounced;
}
