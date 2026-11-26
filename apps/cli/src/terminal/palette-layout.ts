import type { Geometry } from "./screen.js";

const headingRows = 2;
const maxResults = 7;

export function paletteResultCount(bodyRows: number): number {
  return Math.max(1, Math.min(maxResults, bodyRows - headingRows));
}

export function paletteBounds(layout: Geometry): {
  top: number;
  left: number;
  width: number;
} {
  const bodyRows = layout.rows - 2;
  const width = Math.max(0, Math.min(54, layout.cols - layout.sidebar - 2));
  return {
    top:
      2 +
      Math.max(
        0,
        Math.floor((bodyRows - headingRows - paletteResultCount(bodyRows)) / 3),
      ),
    left:
      1 +
      layout.contentStart +
      Math.floor((layout.cols - layout.sidebar - width) / 2),
    width,
  };
}
