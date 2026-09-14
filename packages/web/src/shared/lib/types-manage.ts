// ---------------------------------------------------------------------------
// Management API types
// ---------------------------------------------------------------------------

export type Project = {
  id: string;
  name: string;
  orgName: string;
  keyCount: number;
  createdAt: string;
};

export type ProjectKey = {
  id: string;
  publicKey: string;
  displaySecretKey: string;
  note: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export type CreatedKey = {
  id: string;
  publicKey: string;
  secretKey: string;
  displaySecretKey: string;
};
