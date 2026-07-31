/**
 * Gateway Providers management page.
 */
import { Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useState } from "react";
import { ProviderDialog } from "@/features/gateway/components/provider-dialog";
import { StatusBadge } from "@/features/gateway/components/status-badge";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { toast } from "@/shared/components/toast";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent } from "@/shared/components/ui/card";
import {
  useGwCreateProviderMutation,
  useGwDeleteProviderMutation,
  useGwProvidersQuery,
  useGwUpdateProviderMutation,
} from "@/shared/hooks/gateway-queries";
import type { GatewayProvider } from "@/shared/lib/gateway-api";

function ProvidersContent() {
  const providersQuery = useGwProvidersQuery();
  const createProvider = useGwCreateProviderMutation();
  const updateProvider = useGwUpdateProviderMutation();
  const deleteProvider = useGwDeleteProviderMutation();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<GatewayProvider | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<GatewayProvider | null>(null);

  const providers = providersQuery.data ?? [];

  const handleSubmit = (body: Parameters<typeof createProvider.mutate>[0]) => {
    if (editing) {
      updateProvider.mutate(
        { id: editing.id, body },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditing(null);
            toast.success("Provider updated");
          },
          onError: (err) => toast.error("Update failed", err.message),
        },
      );
    } else {
      createProvider.mutate(body, {
        onSuccess: () => {
          setDialogOpen(false);
          toast.success("Provider created");
        },
        onError: (err) => toast.error("Create failed", err.message),
      });
    }
  };

  const toggleEnabled = (p: GatewayProvider) => {
    updateProvider.mutate(
      { id: p.id, body: { isEnabled: !p.isEnabled } },
      {
        onSuccess: () => toast.success(p.isEnabled ? "Provider disabled" : "Provider enabled"),
        onError: (err) => toast.error("Update failed", err.message),
      },
    );
  };

  if (providersQuery.isLoading) return <LoadingRows />;
  if (providersQuery.error) return <ErrorState error={providersQuery.error} />;

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Add Provider
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {providers.length === 0 ? (
            <EmptyState message="No providers yet. Add your first LLM provider." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="hidden px-4 py-3 lg:table-cell">Base URL</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Budget</th>
                  <th className="px-4 py-3">Spend</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-border/50 transition-colors hover:bg-surface-overlay/40"
                  >
                    <td className="px-4 py-3 font-medium text-fg-primary">
                      {p.name}
                      <span className="ml-2 text-xs font-normal text-fg-tertiary">
                        {p.deploymentCount} model{p.deploymentCount === 1 ? "" : "s"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-fg-tertiary">
                        {p.type}
                      </span>
                    </td>
                    <td className="hidden max-w-[240px] truncate px-4 py-3 font-mono text-xs text-fg-tertiary lg:table-cell">
                      {p.baseUrl}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.isEnabled ? p.status : "disabled"} />
                    </td>
                    <td className="px-4 py-3 text-fg-secondary">
                      {p.budgetLimit != null ? `$${p.budgetLimit}` : "—"}
                      {p.budgetPeriod && (
                        <span className="ml-1 text-xs text-fg-tertiary">/{p.budgetPeriod}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-fg-secondary">
                      ${p.budgetSpend.toFixed(4)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          title={p.isEnabled ? "Disable" : "Enable"}
                          onClick={() => toggleEnabled(p)}
                        >
                          <Power className={`h-3.5 w-3.5 ${p.isEnabled ? "text-success" : "text-fg-tertiary"}`} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Edit"
                          onClick={() => {
                            setEditing(p);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Delete"
                          onClick={() => setConfirmDelete(p)}
                        >
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

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg border border-border bg-surface-raised p-5 shadow-lg">
            <p className="text-sm font-medium text-fg-primary">
              Delete provider &ldquo;{confirmDelete.name}&rdquo;?
            </p>
            <p className="mt-1 text-xs text-fg-tertiary">
              This will also remove all its model deployments. This action cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteProvider.isPending}
                onClick={() =>
                  deleteProvider.mutate(confirmDelete.id, {
                    onSuccess: () => {
                      setConfirmDelete(null);
                      toast.success("Provider deleted");
                    },
                    onError: (err) => toast.error("Delete failed", err.message),
                  })
                }
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      <ProviderDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        provider={editing}
        onSubmit={handleSubmit}
        isPending={createProvider.isPending || updateProvider.isPending}
      />
    </div>
  );
}

export function GatewayProvidersPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Providers" description="LLM provider connections and health." />
      <div className="flex-1 overflow-y-auto">
        <ProvidersContent />
      </div>
    </div>
  );
}
