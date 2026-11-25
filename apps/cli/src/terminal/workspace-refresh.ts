/** Poll workspace metadata without overlapping requests or watching inactive PTYs. */
export function watchWorkspaceList(refresh: () => Promise<void>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void refresh().finally(schedule), 2000);
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
