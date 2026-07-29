import { Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createProjectKey, deleteProjectKey, listProjectKeys } from "@/lib/api";
import type { CreatedKey, ProjectKey } from "@/lib/types";
import { useProjectContext } from "@/store/project";

export function SettingsPage() {
  const ctx = useProjectContext();
  const [keys, setKeys] = useState<ProjectKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<CreatedKey | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    if (!ctx) return;
    try {
      setKeys(await listProjectKeys(ctx.projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreateKey = async () => {
    if (!ctx) return;
    setCreating(true);
    setError("");
    try {
      const created = await createProjectKey(ctx.projectId);
      setNewKey(created);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (keyId: string) => {
    try {
      await deleteProjectKey(keyId);
      setKeys((prev) => prev.filter((k) => k.id !== keyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete key");
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <div className="mx-auto max-w-2xl p-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            API Keys
          </CardTitle>
          <CardDescription>
            Keys for project <span className="font-medium">{ctx?.projectName}</span>. Use these with
            the Peri-Fuse SDK or any Langfuse-compatible client.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Button onClick={handleCreateKey} disabled={creating}>
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create new key
            </Button>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : keys.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No API keys yet. Create one to start ingesting data.
            </p>
          ) : (
            <div className="space-y-2">
              {keys.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center justify-between rounded-md border border-border px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm">{k.publicKey}</div>
                    <div className="text-xs text-muted-foreground">
                      {k.displaySecretKey} · {new Date(k.createdAt).toLocaleDateString()}
                      {k.note ? ` · ${k.note}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Copy public key"
                      onClick={() => copyToClipboard(k.publicKey, k.id)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      {copied === k.id && <span className="ml-1 text-xs">Copied</span>}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Delete key"
                      onClick={() => handleDelete(k.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-400" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* New key dialog */}
      <Dialog open={!!newKey} onOpenChange={() => setNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>
              Save the secret key now — it cannot be shown again.
            </DialogDescription>
          </DialogHeader>
          {newKey && (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Public Key</label>
                <div className="mt-1 flex items-center gap-2 rounded-md bg-muted px-3 py-2">
                  <code className="flex-1 truncate text-sm">{newKey.publicKey}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(newKey.publicKey, "pk")}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Secret Key</label>
                <div className="mt-1 flex items-center gap-2 rounded-md bg-muted px-3 py-2">
                  <code className="flex-1 truncate text-sm">{newKey.secretKey}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(newKey.secretKey, "sk")}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <Button onClick={() => setNewKey(null)}>Done</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
