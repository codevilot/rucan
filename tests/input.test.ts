import { expect, it } from "vitest";
import { InputRouter } from "../apps/cli/src/terminal/input.js";

it("leaves application control keys and arrows intact", () => {
  const router = new InputRouter();
  const bytes = Buffer.from("\x03\x07\t\x1b[A");
  expect([...router.route(bytes)]).toEqual([{ type: "bytes", bytes }]);
});

it("recognizes split paste delimiters without intercepting control keys inside a paste", () => {
  const router = new InputRouter();
  expect([...router.route(Buffer.from("\x1b"))]).toEqual([]);
  expect([...router.route(Buffer.from("[200~\x07\x1b[201"))]).toEqual([
    { type: "paste-start" },
    { type: "bytes", bytes: Buffer.of(7) },
  ]);
  expect([...router.route(Buffer.from("~"))]).toEqual([{ type: "paste-end" }]);
});

it("passes F12 through and opens the palette with split Alt+Space", () => {
  const router = new InputRouter();
  const bytes = Buffer.from("\x1b[24~");
  expect([...router.route(bytes)]).toEqual([{ type: "bytes", bytes }]);
  expect([...router.route(Buffer.from("\x1b"))]).toEqual([]);
  expect([...router.route(Buffer.from(" "))]).toEqual([{ type: "palette" }]);
});

it("parses split SGR mouse reports and allows lone Escape to be forwarded", () => {
  const router = new InputRouter();
  expect([...router.route(Buffer.from("\x1b[<0;10"))]).toEqual([]);
  expect([...router.route(Buffer.from(";5M"))]).toEqual([
    { type: "mouse", button: 0, col: 10, row: 5, release: false },
  ]);
  expect([...router.route(Buffer.of(27))]).toEqual([]);
  expect(router.takePending()).toEqual(Buffer.of(27));
});

it.each([3, 9])(
  "opens the palette for split CSI-u Space with modifier %i",
  (modifier) => {
    const router = new InputRouter();
    expect([...router.route(Buffer.from("\x1b[32;"))]).toEqual([]);
    expect([...router.route(Buffer.from(`${modifier}u`))]).toEqual([
      { type: "palette" },
    ]);
  },
);

it("preserves shortcut bytes inside paste and forwards other CSI-u keys", () => {
  const router = new InputRouter();
  const shortcut = Buffer.from("\x1b[32;9u");
  expect([
    ...router.route(
      Buffer.concat([
        Buffer.from("\x1b[200~"),
        shortcut,
        Buffer.from("\x1b[201~"),
      ]),
    ),
  ]).toEqual([
    { type: "paste-start" },
    { type: "bytes", bytes: shortcut },
    { type: "paste-end" },
  ]);
  const controlSpace = Buffer.from("\x1b[32;5u");
  expect([...router.route(controlSpace)]).toEqual([
    { type: "bytes", bytes: controlSpace },
  ]);
});
