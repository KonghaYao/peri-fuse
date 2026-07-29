/** Stub: Redis OTel ingestion queue not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const OtelIngestionQueue = {
  add: async (_name?: any, _data?: any) => {},
  addBulk: async (_data: any[]) => {},
  getInstance: (_opts?: any) => OtelIngestionQueue,
};
export type OtelIngestionQueueJob = any;
