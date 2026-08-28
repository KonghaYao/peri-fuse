import { describe, expect, it } from "vitest";
import { DEFAULT_LITE_SERVER_PORT, resolveLiteServerPort } from "./port";

describe("resolveLiteServerPort", () => {
  it("uses the production default when the setting is omitted", () => {
    expect(resolveLiteServerPort(undefined)).toBe(DEFAULT_LITE_SERVER_PORT);
    expect(resolveLiteServerPort("")).toBe(DEFAULT_LITE_SERVER_PORT);
  });

  it("accepts canonical decimal TCP ports", () => {
    expect(resolveLiteServerPort("1")).toBe(1);
    expect(resolveLiteServerPort("23332")).toBe(23332);
    expect(resolveLiteServerPort("65535")).toBe(65535);
  });

  it.each([
    "0",
    "-1",
    "65536",
    "1.5",
    "1e3",
    " 23332",
    "23332 ",
    "+23332",
    "023332",
    "24332x",
    "NaN",
    "999999999999999999999",
  ])("rejects invalid setting %j instead of partially parsing it", (rawPort) => {
    expect(() => resolveLiteServerPort(rawPort)).toThrowError(
      /LITE_SERVER_PORT must be a decimal integer between 1 and 65535/,
    );
  });
});
