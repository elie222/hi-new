import { expect, test } from "bun:test";
import { parsePromoOptions } from "../scripts/promo-options";

test("promo restrictions reject missing, duplicate, unknown, and invalid values", () => {
  for (const args of [
    ["LAUNCH", "--max"],
    ["LAUNCH", "--expires"],
    ["LAUNCH", "--maxx", "100"],
    ["LAUNCH", "--max", "1", "--max", "2"],
    ["LAUNCH", "--max", "1.5"],
    ["LAUNCH", "--max", "Infinity"],
    ["LAUNCH", "--max", "9007199254740992"],
    ["LAUNCH", "--expires", "2030-02-31"],
    ["LAUNCH", "--expires", "2030-2-01"],
  ])
    expect(() => parsePromoOptions(args)).toThrow();
  expect(parsePromoOptions(["launch", "--max", "100", "--expires", "2030-12-31"])).toEqual({
    code: "LAUNCH",
    max: 100,
    expires: Math.floor(new Date("2030-12-31T23:59:59Z").getTime() / 1000),
  });
});
