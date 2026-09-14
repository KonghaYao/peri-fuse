import "@testing-library/jest-dom/vitest";

// @peri/ui pulls optional canvas-backed deps in tests; jsdom does not implement getContext.
HTMLCanvasElement.prototype.getContext = () => null;
window.scrollTo = () => {};
