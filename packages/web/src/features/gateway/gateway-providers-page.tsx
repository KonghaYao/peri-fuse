/**
 * Gateway Providers management page.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardContent,
  message,
  PageHeaderShell,
} from "@peri/ui";
import { Loader2, Pencil, Plus, Power, Trash2 } from "lucide-solid";
import { type Component, createSignal, Show } from "solid-js";
import { GatewayProjectGate } from "@/features/gateway/components/gateway-project-gate";
import { LoadingRows } from "@/features/gateway/components/loading-rows";
import { ProviderDialog } from "@/features/gateway/components/provider-dialog";
import { StatusBadge } from "@/features/gateway/components/status-badge";
import {
  useGwCreateProviderMutation,
  useGwDeleteProviderMutation,
  useGwProvidersQuery,
  useGwUpdateProviderMutation,
} from "@/shared/hooks/gateway-queries";
import type { GatewayProvider } from "@/shared/lib/gateway-api";

const ProvidersContent: Component = () => {
  const providersQuery = useGwProvidersQuery();
  const createProvider = useGwCreateProviderMutation();
  const updateProvider = useGwUpdateProviderMutation();
  const deleteProvider = useGwDeleteProviderMutation();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editing, setEditing] = createSignal<GatewayProvider | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<GatewayProvider | null>(null);

  const providers = () => providersQuery.data ?? [];
  const deleteDeploymentCount = () => deleteTarget()?.deploymentCount ?? 0;

  const handleSubmit = (body: Parameters<typeof createProvider.mutate>[0]) => {
    const current = editing();
    if (current) {
      void updateProvider
        .mutateAsync({ id: current.id, body })
        .then(() => {
          setDialogOpen(false);
          setEditing(null);
          message.success("Provider updated");
        })
        .catch((err) => message.error(err instanceof Error ? err.message : "Update failed"));
      return;
    }
    void createProvider
      .mutateAsync(body)
      .then(() => {
        setDialogOpen(false);
        message.success("Provider created");
      })
      .catch((err) => message.error(err instanceof Error ? err.message : "Create failed"));
  };

  const toggleEnabled = (p: GatewayProvider) => {
    void updateProvider
      .mutateAsync({ id: p.id, body: { isEnabled: !p.isEnabled } })
      .then(() => message.success(p.isEnabled ? "Provider disabled" : "Provider enabled"))
      .catch((err) => message.error(err instanceof Error ? err.message : "Update failed"));
  };

  const confirmProviderDelete = () => {
    const target = deleteTarget();
    if (!target || deleteProvider.isPending) return;
    void deleteProvider
      .mutateAsync(target.id)
      .then(() => {
        setDeleteTarget(null);
        message.success("Provider deleted");
      })
      .catch((err) => message.error(err instanceof Error ? err.message : "Delete failed"));
  };

  return (
    <div class="p-6">
      <div class="mb-4 flex justify-end">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          leadingIcon={<Plus class="h-4 w-4" size={16} />}
        >
          Add Provider
        </Button>
      </div>

      <Show
        when={providersQuery.isPending}
        fallback={
          <Show
            when={providersQuery.isError}
            fallback={
              <Card>
                <CardContent class="p-0">
                  <Show
                    when={providers().length > 0}
                    fallback={
                      <p class="py-8 text-center text-sm text-fg-tertiary">
                        No providers yet. Add your first LLM provider.
                      </p>
                    }
                  >
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                          <th class="px-4 py-3">Name</th>
                          <th class="px-4 py-3">Type</th>
                          <th class="hidden px-4 py-3 lg:table-cell">Base URL</th>
                          <th class="px-4 py-3">Status</th>
                          <th class="px-4 py-3">Budget</th>
                          <th class="px-4 py-3">Spend</th>
                          <th class="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {providers().map((p) => (
                          <tr class="border-b border-border/50 transition-colors hover:bg-surface-overlay/40">
                            <td class="px-4 py-3 font-medium text-fg-primary">
                              {p.name}
                              <span class="ml-2 text-xs font-normal text-fg-tertiary">
                                {p.deploymentCount} model{p.deploymentCount === 1 ? "" : "s"}
                              </span>
                            </td>
                            <td class="px-4 py-3">
                              <span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-fg-tertiary">
                                {p.type}
                              </span>
                            </td>
                            <td class="hidden max-w-[240px] truncate px-4 py-3 font-mono text-xs text-fg-tertiary lg:table-cell">
                              {p.baseUrl}
                            </td>
                            <td class="px-4 py-3">
                              <StatusBadge status={p.isEnabled ? p.status : "disabled"} />
                            </td>
                            <td class="px-4 py-3 text-fg-secondary">
                              {p.budgetLimit != null ? `$${p.budgetLimit}` : "—"}
                              {p.budgetPeriod && (
                                <span class="ml-1 text-xs text-fg-tertiary">/{p.budgetPeriod}</span>
                              )}
                            </td>
                            <td class="px-4 py-3 font-mono text-xs text-fg-secondary">
                              ${p.budgetSpend.toFixed(4)}
                            </td>
                            <td class="px-4 py-3">
                              <div class="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title={p.isEnabled ? "Disable" : "Enable"}
                                  onClick={() => toggleEnabled(p)}
                                >
                                  <Power
                                    class={`h-3.5 w-3.5 ${p.isEnabled ? "text-success" : "text-fg-tertiary"}`}
                                    size={14}
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
                                  <Pencil class="h-3.5 w-3.5" size={14} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Delete"
                                  aria-label={`Delete provider ${p.name}`}
                                  onClick={() => setDeleteTarget(p)}
                                >
                                  <Trash2 class="h-3.5 w-3.5 text-danger" size={14} />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Show>
                </CardContent>
              </Card>
            }
          >
            <div
              role="alert"
              class="flex items-center justify-between rounded-md border border-danger/30 bg-danger-subtle px-3 py-2"
            >
              <p class="text-sm text-danger">
                {providersQuery.error instanceof Error
                  ? providersQuery.error.message
                  : "Failed to load providers"}
              </p>
              <Button
                variant="default"
                size="sm"
                onClick={() => void providersQuery.refetch()}
                disabled={providersQuery.isFetching}
              >
                Retry
              </Button>
            </div>
          </Show>
        }
      >
        <LoadingRows />
      </Show>

      <AlertDialog
        open={deleteTarget() !== null}
        onOpenChange={(open) => !open && !deleteProvider.isPending && setDeleteTarget(null)}
      >
        <AlertDialogContent class="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete provider?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the provider connection and all associated model deployments. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <dl class="space-y-2 rounded-md border border-border bg-surface-inset p-3 text-sm">
            <div class="flex items-start justify-between gap-4">
              <dt class="text-fg-tertiary">Name</dt>
              <dd class="break-all text-right font-medium text-fg-primary">
                {deleteTarget()?.name || "(unnamed provider)"}
              </dd>
            </div>
            <div class="flex items-start justify-between gap-4">
              <dt class="text-fg-tertiary">Type</dt>
              <dd class="break-all text-right font-mono text-fg-primary">
                {deleteTarget()?.type || "(unknown type)"}
              </dd>
            </div>
            <div class="flex items-start justify-between gap-4">
              <dt class="text-fg-tertiary">Deployments removed</dt>
              <dd class="text-right text-fg-primary">
                {deleteDeploymentCount()} deployment{deleteDeploymentCount() === 1 ? "" : "s"}
              </dd>
            </div>
          </dl>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProvider.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              disabled={deleteProvider.isPending}
              onClick={confirmProviderDelete}
            >
              <Show when={deleteProvider.isPending}>
                <Loader2 class="h-4 w-4 animate-spin" size={16} />
              </Show>
              Delete provider
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProviderDialog
        open={dialogOpen()}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        provider={editing()}
        onSubmit={handleSubmit}
        isPending={createProvider.isPending || updateProvider.isPending}
      />
    </div>
  );
};

export const GatewayProvidersPage: Component = () => (
  <GatewayProjectGate title="Providers" description="LLM provider connections and health.">
    <div class="flex h-full flex-col">
      <PageHeaderShell title="Providers" description="LLM provider connections and health." />
      <div class="flex-1 overflow-y-auto">
        <ProvidersContent />
      </div>
    </div>
  </GatewayProjectGate>
);
