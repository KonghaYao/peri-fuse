/** Type stub for ioredis (not installed in lite mode). */
declare module "ioredis" {
  export type Cluster = any;
  export default class Redis {
    constructor(...args: any[]);
    [key: string]: any;
  }
  // biome-ignore lint/suspicious/noRedeclare: type alias for convenience
  export type Redis = InstanceType<typeof Redis>;
}
