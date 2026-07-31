/**
 * Create/Edit Model Deployment dialog form.
 */
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/shared/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { useGwProvidersQuery } from "@/shared/hooks/gateway-queries";
import type { ModelDeployment } from "@/shared/lib/gateway-api";

interface ModelFormState {
  modelName: string;
  providerId: string;
  providerModel: string;
  inputPrice: string;
  outputPrice: string;
}

const emptyForm: ModelFormState = {
  modelName: "",
  providerId: "",
  providerModel: "",
  inputPrice: "",
  outputPrice: "",
};

export function ModelDialog({
  open,
  onOpenChange,
  deployment,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deployment?: ModelDeployment | null;
  onSubmit: (body: {
    modelName: string;
    providerId: string;
    providerModel: string;
    modelInfo?: { inputPrice?: number; outputPrice?: number } | null;
  }) => void;
  isPending: boolean;
}) {
  const providersQuery = useGwProvidersQuery();
  const [form, setForm] = useState<ModelFormState>(emptyForm);
  const isEdit = !!deployment;

  useEffect(() => {
    if (open) {
      setForm(
        deployment
          ? {
              modelName: deployment.modelName,
              providerId: deployment.providerId,
              providerModel: deployment.providerModel,
              inputPrice:
                deployment.modelInfo?.inputPrice != null
                  ? String(deployment.modelInfo.inputPrice)
                  : "",
              outputPrice:
                deployment.modelInfo?.outputPrice != null
                  ? String(deployment.modelInfo.outputPrice)
                  : "",
            }
          : emptyForm,
      );
    }
  }, [open, deployment]);

  const providers = (providersQuery.data ?? []).filter((p) => p.isEnabled);

  const set = (field: keyof ModelFormState) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleSubmit = () => {
    const hasPricing = form.inputPrice || form.outputPrice;
    onSubmit({
      modelName: form.modelName.trim(),
      providerId: form.providerId,
      providerModel: form.providerModel.trim(),
      modelInfo: hasPricing
        ? {
            inputPrice: form.inputPrice ? Number(form.inputPrice) : undefined,
            outputPrice: form.outputPrice ? Number(form.outputPrice) : undefined,
          }
        : null,
    });
  };

  const valid = form.modelName.trim() && form.providerId && form.providerModel.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Deployment" : "Add Deployment"}</DialogTitle>
          <DialogDescription>
            Map a public model alias to a provider&apos;s model.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Model Alias</Label>
            <Input
              placeholder="e.g. gpt-4o"
              value={form.modelName}
              onChange={(e) => set("modelName")(e.target.value)}
            />
            <p className="text-xs text-fg-tertiary">
              The name clients use in their requests.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={form.providerId} onValueChange={set("providerId")}>
              <SelectTrigger>
                <SelectValue placeholder="Select provider…" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Provider Model</Label>
            <Input
              placeholder="e.g. gpt-4o-2024-08-06"
              value={form.providerModel}
              onChange={(e) => set("providerModel")(e.target.value)}
            />
            <p className="text-xs text-fg-tertiary">
              The actual model ID sent to the provider.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Input Price ($/1M)</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="Optional"
                value={form.inputPrice}
                onChange={(e) => set("inputPrice")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Output Price ($/1M)</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="Optional"
                value={form.outputPrice}
                onChange={(e) => set("outputPrice")(e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!valid || isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
