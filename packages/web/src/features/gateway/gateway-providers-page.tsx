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
  BlockLoadingRows,
  Button,
  message,
  PageHeaderShell,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableView,
} from "@peri/ui";
import { Loader2, Pencil, Plus, Power, Trash2 } from "lucide-solid";
import { type Component, createSignal, Show } from "solid-js";
import { GatewayProjectGate } from "@/features/gateway/components/gateway-project-gate";
import { ProviderDialog } from "@/features/gateway/components/provider-dialog";
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
    <div class="p-24">
      <div class="mb-16 flex justify-end">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          leadingIcon={<Plus class="h-16 w-16" size={16} />}
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
              <Show
                when={providers().length > 0}
                fallback={
                  <p class="py-32 text-center text-sm text-fg-tertiary">
                    No providers yet. Add your first LLM provider.
                  </p>
                }
              >
                <TableView>
                  <TableView.Body>
                    <Table wrapperClass="min-h-0 flex-1">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead class="hidden lg:table-cell">Base URL</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Budget</TableHead>
                          <TableHead>Spend</TableHead>
                          <TableHead class="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {providers().map((p) => (
                          <TableRow>
                            <TableCell class="font-medium text-fg-primary">
                              {p.name}
                              <span class="ml-8 text-xs font-normal text-fg-tertiary">
                                {p.deploymentCount} model{p.deploymentCount === 1 ? "" : "s"}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span class="rounded bg-muted px-6 py-2 font-mono text-[10px] uppercase text-fg-tertiary">
                                {p.type}
                              </span>
                            </TableCell>
                            <TableCell class="hidden max-w-[240px] truncate font-mono text-xs text-fg-tertiary lg:table-cell">
                              {p.baseUrl}
                            </TableCell>
                            <TableCell>
                              <StatusPill status={p.isEnabled ? p.status : "disabled"} />
                            </TableCell>
                            <TableCell class="text-fg-secondary">
                              {p.budgetLimit != null ? `$${p.budgetLimit}` : "—"}
                              {p.budgetPeriod && (
                                <span class="ml-4 text-xs text-fg-tertiary">/{p.budgetPeriod}</span>
                              )}
                            </TableCell>
                            <TableCell class="font-mono text-xs text-fg-secondary">
                              ${p.budgetSpend.toFixed(4)}
                            </TableCell>
                            <TableCell>
                              <div class="flex items-center justify-end gap-4">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title={p.isEnabled ? "Disable" : "Enable"}
                                  onClick={() => toggleEnabled(p)}
                                >
                                  <Power
                                    class={`h-14 w-14 ${p.isEnabled ? "text-success" : "text-fg-tertiary"}`}
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
                                  <Pencil class="h-14 w-14" size={14} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Delete"
                                  aria-label={`Delete provider ${p.name}`}
                                  onClick={() => setDeleteTarget(p)}
                                >
                                  <Trash2 class="h-14 w-14 text-danger" size={14} />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableView.Body>
                </TableView>
              </Show>
            }
          >
            <div
              role="alert"
              class="flex items-center justify-between rounded-md border border-danger/30 bg-danger-subtle px-12 py-8"
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
        <BlockLoadingRows />
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

          <dl class="space-y-8 rounded-md border border-border bg-surface-inset p-12 text-sm">
            <div class="flex items-start justify-between gap-16">
              <dt class="text-fg-tertiary">Name</dt>
              <dd class="break-all text-right font-medium text-fg-primary">
                {deleteTarget()?.name || "(unnamed provider)"}
              </dd>
            </div>
            <div class="flex items-start justify-between gap-16">
              <dt class="text-fg-tertiary">Type</dt>
              <dd class="break-all text-right font-mono text-fg-primary">
                {deleteTarget()?.type || "(unknown type)"}
              </dd>
            </div>
            <div class="flex items-start justify-between gap-16">
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
                <Loader2 class="h-16 w-16 animate-spin" size={16} />
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
