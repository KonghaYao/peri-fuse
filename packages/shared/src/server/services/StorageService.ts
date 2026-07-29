/** Stub: StorageService not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export class StorageService {
  static getInstance(): StorageService {
    return new StorageService();
  }
  async upload(_opts: any): Promise<void> {}
  async uploadJson(_path: string, _data: any): Promise<void> {}
  async download(_opts: any): Promise<any> {
    return null;
  }
}
export const StorageServiceFactory = {
  create: (_opts?: any) => new StorageService(),
  getInstance: (_opts?: any) => new StorageService(),
};
