import stringWidth from "string-width";
import { version } from "../release/version.js";

export const reset = "\x1b[0m";
const bar = "\x1b[38;5;252;48;5;235m";
const brand = "\x1b[1;38;5;17;48;5;87m";
const tab = "\x1b[1;38;5;231;48;5;61m";
const sidebar = "\x1b[38;5;250;48;5;234m";
const section = "\x1b[1;38;5;117;48;5;234m";
const edge = "\x1b[38;5;67;48;5;234m";
const good = "\x1b[38;5;120;48;5;235m";
const warning = "\x1b[38;5;221;48;5;235m";
const action = "\x1b[1;38;5;153m";
const button = "\x1b[1;38;5;117;48;5;236m";
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export type Header = string | { tab: string; status: string; healthy: boolean };

export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const safe = text.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "");
  if (stringWidth(safe) <= width) return safe;
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(safe)) {
    used += stringWidth(segment);
    if (used > width) break;
    result += segment;
  }
  return result;
}

function fill(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)));
}

export function renderHeader(header: Header, width: number): string {
  if (typeof header === "string")
    return tab + fill(fit(` ${header}`, width), width) + reset;
  const logo = fit(` rucan v${version} `, width);
  const remaining = width - stringWidth(logo);
  if (remaining < 3) return brand + fill(logo, width) + reset;
  const label = fit(
    ` ▰ ${header.tab} `,
    Math.min(remaining - 1, Math.max(12, Math.floor(width * 0.45))),
  );
  const statusWidth = remaining - stringWidth(label) - 1;
  const status = fit(`  ● ${header.status}`, statusWidth);
  return (
    brand +
    logo +
    reset +
    bar +
    " " +
    tab +
    label +
    reset +
    (header.healthy ? good : warning) +
    fill(status, statusWidth) +
    reset
  );
}

export function renderSidebar(
  text: string,
  width: number,
  heading: boolean,
  right = false,
): string {
  if (width <= 0) return "";
  const label = fit(text, width - 1);
  const style =
    heading || label === "EXPLORER"
      ? section
      : label.startsWith("+ ") || label.startsWith("↗ ")
        ? button
        : label.startsWith("›")
          ? tab
          : sidebar;
  const divider = edge + "│" + reset;
  const content = style + fill(label, width - 1) + reset;
  return right ? divider + content : content + divider;
}

export function renderPaletteLine(
  text: string,
  width: number,
  row: number,
): string {
  const cardWidth = Math.min(54, width - 2);
  if (cardWidth < 4) return "";
  const style =
    row === 0 ? tab : row === 1 ? button : text.startsWith("›") ? tab : bar;
  return (
    " ".repeat(Math.floor((width - cardWidth) / 2)) +
    style +
    fill(fit(` ${text}`, cardWidth), cardWidth) +
    reset
  );
}

export function renderPanelLine(
  text: string,
  width: number,
  row: number,
): string {
  const label = fit(text, width - 2);
  if (!label) return "";
  return row === 0 && width >= 5
    ? `  ${action}◆ ${fit(label, width - 4)}${reset}`
    : `  ${label}`;
}

export function renderFooter(footer: string, width: number): string {
  const badge = fit(` v${version} `, width);
  const bodyWidth = width - stringWidth(badge);
  const [first = "", ...rest] = footer.split(" · ");
  const lead = fit(` ${first} `, bodyWidth);
  const remaining = bodyWidth - stringWidth(lead);
  const hints = rest.length ? fit(`  ${rest.join("  ·  ")}`, remaining) : "";
  return (
    tab +
    lead +
    reset +
    bar +
    fill(hints, remaining) +
    reset +
    brand +
    badge +
    reset
  );
}
