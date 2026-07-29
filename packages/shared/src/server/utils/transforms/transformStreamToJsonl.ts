import { Transform, type TransformCallback } from "node:stream";
import { stringify } from "./stringify";

export function transformStreamToJsonl(): Transform {
  return new Transform({
    objectMode: true,

    transform(
      row: Record<string, any>,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ): void {
      this.push(`${stringify(row)}\n`);
      callback();
    },
  });
}
