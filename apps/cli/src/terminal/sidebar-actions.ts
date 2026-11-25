export const sidebarActions = [
  { key: "n", label: "+ New workspace" },
  { key: "c", label: "↗ SSH connect" },
] as const;

export function workspaceSidebar(
  lines: readonly string[],
  rows: number,
): string[] {
  if (rows < sidebarActions.length + 1) return [...lines];
  const listRows = rows - sidebarActions.length;
  return [
    ...Array.from({ length: listRows }, (_, index) => lines[index] ?? ""),
    ...sidebarActions.map(({ label }) => label),
  ];
}

export function sidebarActionAt(row: number, rows: number): string | undefined {
  if (rows < sidebarActions.length + 1) return undefined;
  return sidebarActions[row - (rows - sidebarActions.length + 2)]?.key;
}
