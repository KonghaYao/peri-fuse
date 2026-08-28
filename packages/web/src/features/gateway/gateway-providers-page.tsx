/**
 * Gateway Providers management page.
 */
import { Loader2, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { ProviderDialog } from "@/features/gateway/components/provider-dialog";
import { StatusBadge } from "@/features/gateway/components/status-badge";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { toast } from "@/shared/components/toast";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent } from "@/shared/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
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
  const [deleteTarget, setDeleteTarget] = useState<GatewayProvider | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const deleteOpenerRef = useRef<HTMLButtonElement | null>(null);

  const providers = providersQuery.data ?? [];
  const deleteDeploymentCount = deleteTarget?.deploymentCount ?? 0;

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

  const confirmProviderDelete = () => {
    if (!deleteTarget || deleteProvider.isPending) return;

    deleteProvider.mutate(deleteTarget.id, {
      onSuccess: () => {
        deleteOpenerRef.current = null;
        setDeleteTarget(null);
        toast.success("Provider deleted");
      },
      onError: (err) => toast.error("Delete failed", err.message),
    });
  };

  if (providersQuery.isLoading) return <LoadingRows />;
  if (providersQuery.error) return <ErrorState error={providersQuery.error} />;

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-end">
        <Button
          ref={addButtonRef}
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
                          <Power
                            className={`h-3.5 w-3.5 ${p.isEnabled ? "text-success" : "text-fg-tertiary"}`}
                          />
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
                          aria-label={`Delete provider ${p.name}`}
                          onClick={(event) => {
                            deleteOpenerRef.current = event.currentTarget;
                            setDeleteTarget(p);
                          }}
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

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteProvider.isPending) setDeleteTarget(null);
        }}
      >
        <DialogContent
          className="max-w-sm"
          hideClose={deleteProvider.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const opener = deleteOpenerRef.current;
            if (opener?.isConnected) opener.focus();
            else addButtonRef.current?.focus();
            deleteOpenerRef.current = null;
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete provider?</DialogTitle>
            <DialogDescription>
              This removes the provider connection and all associated model deployments. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <dl className="space-y-2 rounded-md border border-border bg-surface-inset p-3 text-sm">
            <div className="flex items-start justify-between gap-4">
              <dt className="text-fg-tertiary">Name</dt>
              <dd className="break-all text-right font-medium text-fg-primary">
                {deleteTarget?.name || "(unnamed provider)"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-fg-tertiary">Type</dt>
              <dd className="break-all text-right font-mono text-fg-primary">
                {deleteTarget?.type || "(unknown type)"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-fg-tertiary">Deployments removed</dt>
              <dd className="text-right text-fg-primary">
                {deleteDeploymentCount} deployment{deleteDeploymentCount === 1 ? "" : "s"}
              </dd>
            </div>
          </dl>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={deleteProvider.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteProvider.isPending}
              onClick={confirmProviderDelete}
            >
              {deleteProvider.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}
              Delete provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
