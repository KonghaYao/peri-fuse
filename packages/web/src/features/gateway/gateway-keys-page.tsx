/**
 * Gateway API Keys management page.
 */
import { Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useState } from "react";
import { KeyDialog } from "@/features/gateway/components/key-dialog";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { toast } from "@/shared/components/toast";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent } from "@/shared/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  useGwCreateKeyMutation,
  useGwDeleteKeyMutation,
  useGwKeysQuery,
  useGwUpdateKeyMutation,
} from "@/shared/hooks/gateway-queries";
import type { GatewayApiKey } from "@/shared/lib/gateway-api";

function EditKeyDialog({
  keyItem,
  onOpenChange,
}: {
  keyItem: GatewayApiKey;
  onOpenChange: (open: boolean) => void;
}) {
  const updateKey = useGwUpdateKeyMutation();
  const [rpm, setRpm] = useState(keyItem.rpmLimit != null ? String(keyItem.rpmLimit) : "");
  const [tpm, setTpm] = useState(keyItem.tpmLimit != null ? String(keyItem.tpmLimit) : "");
  const [maxParallel, setMaxParallel] = useState(
    keyItem.maxParallel != null ? String(keyItem.maxParallel) : "",
  );
  const [maxBudget, setMaxBudget] = useState(
    keyItem.maxBudget != null ? String(keyItem.maxBudget) : "",
  );

  const save = () => {
    updateKey.mutate(
      {
        id: keyItem.id,
        body: {
          rpmLimit: rpm ? Number(rpm) : null,
          tpmLimit: tpm ? Number(tpm) : null,
          maxParallel: maxParallel ? Number(maxParallel) : null,
          maxBudget: maxBudget ? Number(maxBudget) : null,
        },
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success("Key limits updated");
        },
        onError: (err) => toast.error("Update failed", err.message),
      },
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Limits</DialogTitle>
          <DialogDescription>
            {keyItem.keyName ?? keyItem.publicKey} — adjust rate limits and budget.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>RPM</Label>
              <Input type="number" value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="∞" />
            </div>
            <div className="space-y-1.5">
              <Label>TPM</Label>
              <Input type="number" value={tpm} onChange={(e) => setTpm(e.target.value)} placeholder="∞" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Max Parallel</Label>
              <Input
                type="number"
                value={maxParallel}
                onChange={(e) => setMaxParallel(e.target.value)}
                placeholder="∞"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Max Budget ($)</Label>
              <Input
                type="number"
                step="0.01"
                value={maxBudget}
                onChange={(e) => setMaxBudget(e.target.value)}
                placeholder="∞"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={updateKey.isPending}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function KeysContent() {
  const keysQuery = useGwKeysQuery();
  const createKey = useGwCreateKeyMutation();
  const updateKey = useGwUpdateKeyMutation();
  const deleteKey = useGwDeleteKeyMutation();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<GatewayApiKey | null>(null);

  const keys = keysQuery.data ?? [];

  const handleCreate = (body: Parameters<typeof createKey.mutate>[0]) => {
    createKey.mutate(body, {
      onSuccess: () => {
        setCreateOpen(false);
        toast.success("Key config created");
      },
      onError: (err) => toast.error("Create failed", err.message),
    });
  };

  const toggleEnabled = (k: GatewayApiKey) => {
    updateKey.mutate(
      { id: k.id, body: { isEnabled: !k.isEnabled } },
      {
        onSuccess: () => toast.success(k.isEnabled ? "Key disabled" : "Key enabled"),
        onError: (err) => toast.error("Update failed", err.message),
      },
    );
  };

  const remove = (k: GatewayApiKey) => {
    deleteKey.mutate(k.id, {
      onSuccess: () => toast.success("Key deleted"),
      onError: (err) => toast.error("Delete failed", err.message),
    });
  };

  if (keysQuery.isLoading) return <LoadingRows />;
  if (keysQuery.error) return <ErrorState error={keysQuery.error} />;

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Key
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {keys.length === 0 ? (
            <EmptyState message="No API keys. Create one to access the gateway proxy." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Public Key</th>
                  <th className="px-4 py-3">Spend</th>
                  <th className="hidden px-4 py-3 md:table-cell">RPM</th>
                  <th className="hidden px-4 py-3 md:table-cell">TPM</th>
                  <th className="hidden px-4 py-3 lg:table-cell">Budget</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="hidden px-4 py-3 lg:table-cell">Created</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr
                    key={k.id}
                    className="border-b border-border/50 transition-colors hover:bg-surface-overlay/40"
                  >
                    <td className="px-4 py-3 font-medium text-fg-primary">
                      {k.keyName ?? <span className="text-fg-tertiary">unnamed</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-fg-secondary">
                      {k.publicKey.slice(0, 16)}…
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-fg-secondary">
                      ${k.spend.toFixed(4)}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-fg-tertiary md:table-cell">
                      {k.rpmLimit ?? "∞"}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-fg-tertiary md:table-cell">
                      {k.tpmLimit ?? "∞"}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-fg-tertiary lg:table-cell">
                      {k.maxBudget != null ? `$${k.maxBudget}` : "∞"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          k.isEnabled
                            ? "border-success/30 bg-success-subtle text-success"
                            : "border-border bg-muted text-fg-tertiary"
                        }`}
                      >
                        {k.isEnabled ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-fg-tertiary lg:table-cell">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          title={k.isEnabled ? "Disable" : "Enable"}
                          onClick={() => toggleEnabled(k)}
                        >
                          <Power
                            className={`h-3.5 w-3.5 ${k.isEnabled ? "text-success" : "text-fg-tertiary"}`}
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Edit limits"
                          onClick={() => setEditingKey(k)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" title="Delete" onClick={() => remove(k)}>
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <KeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
        isPending={createKey.isPending}
      />

      {editingKey && <EditKeyDialog keyItem={editingKey} onOpenChange={(v) => !v && setEditingKey(null)} />}
    </div>
  );
}

export function GatewayKeysPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="API Keys" description="Gateway access keys with rate limits and budgets." />
      <div className="flex-1 overflow-y-auto">
        <KeysContent />
      </div>
    </div>
  );
}
