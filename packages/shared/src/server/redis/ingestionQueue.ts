/** Stub: Redis ingestion queue not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const IngestionQueue = {
  add: async (_name?: any, _data?: any, _opts?: any) => {},
  addBulk: async (_data: any[]) => {},
  getInstance: (_opts?: any) => IngestionQueue,
};
export type IngestionQueueJob = any;
