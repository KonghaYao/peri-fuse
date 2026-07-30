import { Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/shared/components/state";
import { toast } from "@/shared/components/toast";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import {
  useCreateKeyMutation,
  useDeleteKeyMutation,
  useProjectKeysQuery,
} from "@/shared/hooks/queries";
import type { CreatedKey } from "@/shared/lib/types";
import { useProjectContext } from "@/shared/store/project";

export function SettingsPage() {
  const ctx = useProjectContext();
  const [newKey, setNewKey] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState("");

  const keysQuery = useProjectKeysQuery(ctx?.projectId);
  const createKey = useCreateKeyMutation(ctx?.projectId ?? "");
  const deleteKey = useDeleteKeyMutation(ctx?.projectId ?? "");

  const keys = keysQuery.data ?? [];

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
    toast.success("Copied to clipboard");
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Settings"
        description={`API keys for project "${ctx?.projectName ?? ""}".`}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <KeyRound className="h-4 w-4 text-brand" />
                API Keys
              </CardTitle>
              <CardDescription>
                Use these with the Peri-Fuse SDK or any Langfuse-compatible client.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Button
                  onClick={() =>
                    createKey.mutate(undefined, {
                      onSuccess: (key) => {
                        setNewKey(key);
                        toast.success("API key created");
                      },
                      onError: (err) =>
                        toast.error(
                          "Failed to create key",
                          err instanceof Error ? err.message : undefined,
                        ),
                    })
                  }
                  disabled={createKey.isPending}
                >
                  {createKey.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Create new key
                </Button>
              </div>

              {keysQuery.isLoading ? (
                <div className="flex items-center justify-center py-8 text-fg-tertiary">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : keys.length === 0 ? (
                <p className="py-8 text-center text-sm text-fg-tertiary">
                  No API keys yet. Create one to start ingesting data.
                </p>
              ) : (
                <div className="space-y-2">
                  {keys.map((k) => (
                    <div
                      key={k.id}
                      className="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-sm text-fg-primary">
                          {k.publicKey}
                        </div>
                        <div className="text-xs text-fg-tertiary">
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
                          onClick={() =>
                            deleteKey.mutate(k.id, {
                              onSuccess: () => toast.success("API key deleted"),
                              onError: (err) =>
                                toast.error(
                                  "Failed to delete key",
                                  err instanceof Error ? err.message : undefined,
                                ),
                            })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

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
                <label className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  Public Key
                </label>
                <div className="mt-1 flex items-center gap-2 rounded-md border border-border bg-surface-inset px-3 py-2">
                  <code className="flex-1 truncate font-mono text-sm">{newKey.publicKey}</code>
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
                <label className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  Secret Key
                </label>
                <div className="mt-1 flex items-center gap-2 rounded-md border border-border bg-surface-inset px-3 py-2">
                  <code className="flex-1 truncate font-mono text-sm">{newKey.secretKey}</code>
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
