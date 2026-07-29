/**
 * Stub: Instrumentation is not available in lite mode.
 * All functions are no-ops. A no-op span object is provided so callers
 * can safely call span.setAttribute() etc. without optional chaining.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const noopSpan: any = {
  setAttribute() {
    return noopSpan;
  },
  setAttributes() {
    return noopSpan;
  },
  addEvent() {
    return noopSpan;
  },
  setStatus() {
    return noopSpan;
  },
  recordException() {
    return noopSpan;
  },
  end() {},
  isRecording() {
    return false;
  },
  spanContext() {
    return { traceId: "", spanId: "", traceFlags: 0 };
  },
};

export async function instrumentAsync<T>(_opts: any, fn: (span?: any) => Promise<T>): Promise<T> {
  return fn(noopSpan);
}

export function instrumentSync<T>(_opts: any, fn: (span?: any) => T): T {
  return fn(noopSpan);
}

export function recordIncrement(_name: string, _value?: number, _attrs?: any): void {}
export function recordDistribution(_name: string, _value: number, _attrs?: any): void {}
export function recordGauge(_name: string, _value: number, _attrs?: any): void {}
export function traceException(_error: unknown, _span?: any): void {}
export function getCurrentSpan(): any {
  return noopSpan;
}
