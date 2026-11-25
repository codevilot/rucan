import type { MouseEvent } from "./input.js";

export function sidebarWidth(cols: number, preferred?: number): number {
  if (cols < 48 || preferred === 0) return 0;
  return Math.min(
    cols - 24,
    Math.max(16, preferred ?? Math.floor(cols * 0.25)),
  );
}

export class SidebarLayout {
  #preferred: number | undefined;
  #collapsed = false;
  #dragging = false;

  get preferred(): number | undefined {
    return this.#collapsed ? 0 : this.#preferred;
  }

  toggle(): void {
    this.#dragging = false;
    this.#collapsed = !this.#collapsed;
  }

  mouse(
    event: MouseEvent,
    sidebar: number,
    rows: number,
  ): "pass" | "paint" | "resize" {
    if (this.#dragging) {
      if (event.release) {
        this.#dragging = false;
        return "resize";
      }
      if ((event.button & 35) === 32) {
        this.#preferred = event.col;
      }
      return "paint";
    }
    if (
      sidebar > 0 &&
      event.col === sidebar &&
      event.row > 1 &&
      event.row < rows &&
      event.button === 0 &&
      !event.release
    ) {
      this.#dragging = true;
      return "paint";
    }
    return "pass";
  }
}
