import { expect, it } from "vitest";
import {
  compareVersions,
  stableVersion,
} from "../apps/cli/src/release/version.js";

it("compares stable releases numerically", () => {
  expect(compareVersions("0.10.1", "0.9.9")).toBe(1);
  expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  expect(compareVersions("2.3.4", "2.3.4")).toBe(0);
  expect(stableVersion("2.0.0-beta.1")).toBeUndefined();
  expect(stableVersion("01.2.3")).toBeUndefined();
});
