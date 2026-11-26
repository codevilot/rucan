import type { Geometry } from "./screen.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Edge = "left" | "right" | "top" | "bottom";
type Axis = "x" | "y";
type Tree =
  { id: string } | { axis: Axis; ratio: number; first: Tree; second: Tree };

export interface Pane extends Rect {
  id: string;
}

export interface Divider extends Rect {
  split: Extract<Tree, { axis: Axis }>;
  bounds: Rect;
}

const maxPanes = 4;

export function contains(rect: Rect, row: number, col: number): boolean {
  return (
    col >= rect.x &&
    col < rect.x + rect.width &&
    row >= rect.y &&
    row < rect.y + rect.height
  );
}

function body(layout: Geometry): Rect {
  return {
    x: layout.contentStart + 1,
    y: 2,
    width: layout.cols - layout.sidebar,
    height: layout.rows - 2,
  };
}

function minimum(tree: Tree, axis: Axis): number {
  if ("id" in tree) return axis === "x" ? 14 : 4;
  const first = minimum(tree.first, axis);
  const second = minimum(tree.second, axis);
  return tree.axis === axis ? first + second + 1 : Math.max(first, second);
}

function partition(
  rect: Rect,
  split: Divider["split"],
): { first: Rect; second: Rect; separator: Rect } {
  const size = split.axis === "x" ? "width" : "height";
  const span = rect[size] - 1;
  const first = Math.max(
    minimum(split.first, split.axis),
    Math.min(
      span - minimum(split.second, split.axis),
      Math.round(span * split.ratio),
    ),
  );
  return {
    first: { ...rect, [size]: first },
    second: {
      ...rect,
      [split.axis]: rect[split.axis] + first + 1,
      [size]: span - first,
    },
    separator: { ...rect, [split.axis]: rect[split.axis] + first, [size]: 1 },
  };
}

function describe(
  tree: Tree,
  bounds: Rect,
  panes: Pane[],
  dividers: Divider[],
): void {
  if ("id" in tree) {
    panes.push({ ...bounds, id: tree.id });
    return;
  }
  const { first, second, separator } = partition(bounds, tree);
  dividers.push({ ...separator, split: tree, bounds });
  describe(tree.first, first, panes, dividers);
  describe(tree.second, second, panes, dividers);
}

function replace(
  tree: Tree,
  id: string,
  next: Tree | undefined,
): Tree | undefined {
  if ("id" in tree) return tree.id === id ? next : tree;
  const first = replace(tree.first, id, next);
  const second = replace(tree.second, id, next);
  return first && second ? { ...tree, first, second } : (first ?? second);
}

function ids(tree: Tree | undefined): string[] {
  return !tree
    ? []
    : "id" in tree
      ? [tree.id]
      : [...ids(tree.first), ...ids(tree.second)];
}

export function paneSize(pane: Pane): { rows: number; cols: number } {
  const cols = Math.max(1, Math.min(500, pane.width));
  return {
    cols,
    rows: Math.max(1, Math.min(200, pane.height - 1, Math.floor(12000 / cols))),
  };
}

export class PaneLayout {
  #tree: Tree | undefined;

  get ids(): string[] {
    return ids(this.#tree);
  }

  select(id: string, previous?: string): void {
    if (this.ids.includes(id)) return;
    this.#tree = (this.#tree &&
      previous &&
      replace(this.#tree, previous, { id })) || { id };
  }

  remove(id: string): void {
    if (this.#tree) this.#tree = replace(this.#tree, id, undefined);
  }

  view(layout: Geometry): { panes: Pane[]; dividers: Divider[] } {
    const bounds = body(layout);
    const panes: Pane[] = [];
    const dividers: Divider[] = [];
    if (
      this.#tree &&
      bounds.width >= minimum(this.#tree, "x") &&
      bounds.height >= minimum(this.#tree, "y")
    )
      describe(this.#tree, bounds, panes, dividers);
    return { panes, dividers };
  }

  drop(
    layout: Geometry,
    id: string,
    row: number,
    col: number,
  ): { rect: Rect; apply: () => void } | undefined {
    const tree = this.#tree;
    const current = this.ids;
    if (!tree || (!current.includes(id) && current.length >= maxPanes)) return;
    const target = this.view(layout).panes.find((pane) =>
      contains(pane, row, col),
    );
    if (!target || target.id === id) return;
    const base = replace(tree, id, undefined);
    if (!base) return;
    const x = (col - target.x + 0.5) / target.width;
    const y = (row - target.y + 0.5) / target.height;
    const edges = [
      ["left", x],
      ["right", 1 - x],
      ["top", y],
      ["bottom", 1 - y],
    ] satisfies [Edge, number][];
    const nearest = edges
      .filter(
        ([edge, distance]) =>
          distance <= 0.25 &&
          (edge === "left" || edge === "right"
            ? target.width >= 29
            : target.height >= 9),
      )
      .sort((a, b) => a[1] - b[1])[0];
    if (!nearest) return;
    const [edge] = nearest;
    const before = edge === "left" || edge === "top";
    const split: Divider["split"] = {
      axis: edge === "left" || edge === "right" ? "x" : "y",
      ratio: 0.5,
      first: { id: before ? id : target.id },
      second: { id: before ? target.id : id },
    };
    const next = replace(base, target.id, split);
    if (
      !next ||
      body(layout).width < minimum(next, "x") ||
      body(layout).height < minimum(next, "y")
    )
      return;
    const panes: Pane[] = [];
    describe(next, body(layout), panes, []);
    const rect = panes.find((pane) => pane.id === id);
    if (rect)
      return {
        rect,
        apply: () => {
          this.#tree = next;
        },
      };
    return undefined;
  }

  resize(divider: Divider, row: number, col: number): void {
    const { split, bounds } = divider;
    const span = (split.axis === "x" ? bounds.width : bounds.height) - 1;
    const offset = split.axis === "x" ? col - bounds.x : row - bounds.y;
    split.ratio = Math.max(0, Math.min(1, offset / span));
  }
}
