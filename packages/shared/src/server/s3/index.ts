/** Stub: S3 not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
const storageClient = {
  uploadJson: async (_path: string, _data: any): Promise<void> => {},
  upload: async (_opts: any): Promise<void> => {},
  download: async (_opts: any): Promise<any> => null,
};
export function getS3EventStorageClient(_bucket?: string): any {
  return storageClient;
}
export function getS3MediaStorageClient(_bucket?: string): any {
  return storageClient;
}
export function getS3BlobStorageClient(_bucket?: string): any {
  return storageClient;
}
export type S3Client = any;
