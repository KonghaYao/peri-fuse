/**
 * Local filesystem storage adapter.
 * Replaces S3/MinIO/Azure/GCS in lite mode.
 *
 * Files are stored under `.langfuse/storage/{bucket}/` relative to the
 * project root (or `LANGFUSE_STORAGE_DIR` if set).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type { StorageAdapter } from "./types";

const DEFAULT_STORAGE_DIR = ".langfuse/storage";

export class LocalStorageAdapter implements StorageAdapter {
  private baseDir: string;

  constructor(bucket: string) {
    const storageRoot = process.env.LANGFUSE_STORAGE_DIR ?? DEFAULT_STORAGE_DIR;
    this.baseDir = path.resolve(storageRoot, bucket);
    // Ensure base directory exists
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private getFilePath(fileName: string): string {
    // Sanitize path to prevent directory traversal
    const sanitized = fileName.replace(/\.\./g, "").replace(/^\/+/, "");
    return path.join(this.baseDir, sanitized);
  }

  private ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
  }

  async uploadFile(params: {
    fileName: string;
    fileType: string;
    data: Readable | string;
  }): Promise<void> {
    const filePath = this.getFilePath(params.fileName);
    this.ensureDir(filePath);

    if (typeof params.data === "string") {
      fs.writeFileSync(filePath, params.data, "utf-8");
    } else {
      // Stream to file. Capture the narrowed stream before entering the
      // callback, where control-flow narrowing would otherwise be lost.
      const stream = params.data;
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(filePath);
        stream.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        stream.on("error", reject);
      });
    }
  }

  async uploadJson(
    filePath: string,
    body: Record<string, unknown>[] | Record<string, unknown>,
  ): Promise<void> {
    const fullPath = this.getFilePath(filePath);
    this.ensureDir(fullPath);
    fs.writeFileSync(fullPath, JSON.stringify(body, null, 2), "utf-8");
  }

  async download(filePath: string): Promise<string> {
    const fullPath = this.getFilePath(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return fs.readFileSync(fullPath, "utf-8");
  }

  async listFiles(prefix: string): Promise<{ file: string; createdAt: Date }[]> {
    const dirPath = this.getFilePath(prefix);
    if (!fs.existsSync(dirPath)) {
      return [];
    }

    const results: { file: string; createdAt: Date }[] = [];
    const walkDir = (dir: string, basePrefix: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(basePrefix, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath, relativePath);
        } else {
          const stat = fs.statSync(fullPath);
          results.push({ file: relativePath, createdAt: stat.birthtime });
        }
      }
    };

    if (fs.statSync(dirPath).isDirectory()) {
      walkDir(dirPath, prefix);
    }

    return results;
  }

  async getSignedUrl(
    fileName: string,
    _ttlSeconds: number,
    _asAttachment?: boolean,
  ): Promise<string> {
    // In lite mode, return a local API route that serves the file
    const encodedPath = encodeURIComponent(fileName);
    const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    return `${baseUrl}/api/local-storage/${encodedPath}`;
  }

  async getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  }): Promise<string> {
    // In lite mode, return a local API route for uploads
    const encodedPath = encodeURIComponent(params.path);
    const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    return `${baseUrl}/api/local-storage/upload/${encodedPath}`;
  }

  async deleteFiles(paths: string[]): Promise<void> {
    for (const filePath of paths) {
      const fullPath = this.getFilePath(filePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    const fullPath = this.getFilePath(filePath);
    return fs.existsSync(fullPath);
  }
}
