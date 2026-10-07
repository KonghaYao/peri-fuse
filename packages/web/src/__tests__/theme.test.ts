// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserStorage } from "./browser-storage";

const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const initialThemeScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", createBrowserStorage());
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("default light theme", () => {
  it.each([null, "light", "invalid"])(
    "uses light before first paint and in React for %s",
    async (saved) => {
      if (saved !== null) localStorage.setItem("peri-fuse-theme", saved);
      document.documentElement.classList.add("dark");
      new Function(initialThemeScript)();
      const theme = await import("@/shared/store/theme");
      expect(theme.getTheme()).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(html).not.toMatch(/<html[^>]+class="dark"/);
    },
  );

  it("respects an explicitly saved dark theme", async () => {
    localStorage.setItem("peri-fuse-theme", "dark");
    new Function(initialThemeScript)();
    const theme = await import("@/shared/store/theme");
    expect(theme.getTheme()).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("keeps light mode when browser storage is unavailable", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    new Function(initialThemeScript)();
    const theme = await import("@/shared/store/theme");
    expect(theme.getTheme()).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("still toggles and persists an explicit theme choice", async () => {
    const theme = await import("@/shared/store/theme");
    theme.toggleTheme();
    expect(theme.getTheme()).toBe("dark");
    expect(localStorage.getItem("peri-fuse-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    theme.toggleTheme();
    expect(theme.getTheme()).toBe("light");
    expect(localStorage.getItem("peri-fuse-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
