import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Select,
} from "@peri/ui";
import { Loader2 } from "lucide-solid";
import { type Component, createEffect, createSignal } from "solid-js";
import { z } from "zod";
import { useGwProvidersQuery } from "@/shared/hooks/gateway-queries";
import type { ModelDeployment } from "@/shared/lib/gateway-api";

const modelFormSchema = z.object({
  modelName: z.string().trim().min(1, "Model alias is required"),
  providerId: z.string().min(1, "Please select a provider"),
  providerModel: z.string().trim().min(1, "Provider model is required"),
  inputPrice: z.string().refine((v) => v === "" || !Number.isNaN(Number(v)), {
    message: "Must be a valid number",
  }),
  outputPrice: z.string().refine((v) => v === "" || !Number.isNaN(Number(v)), {
    message: "Must be a valid number",
  }),
});

type ModelFormValues = z.infer<typeof modelFormSchema>;

const emptyValues: ModelFormValues = {
  modelName: "",
  providerId: "",
  providerModel: "",
  inputPrice: "",
  outputPrice: "",
};

function valuesFromDeployment(deployment: ModelDeployment): ModelFormValues {
  return {
    modelName: deployment.modelName,
    providerId: deployment.provider ? deployment.providerId : "",
    providerModel: deployment.providerModel,
    inputPrice:
      deployment.modelInfo?.inputPrice != null ? String(deployment.modelInfo.inputPrice) : "",
    outputPrice:
      deployment.modelInfo?.outputPrice != null ? String(deployment.modelInfo.outputPrice) : "",
  };
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !out[key]) out[key] = issue.message;
  }
  return out;
}

export const ModelDialog: Component<{
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
}> = (props) => {
  const providersQuery = useGwProvidersQuery();
  const [values, setValues] = createSignal<ModelFormValues>(emptyValues);
  const [errors, setErrors] = createSignal<Record<string, string>>({});

  const isEdit = () => Boolean(props.deployment);
  const providerUnavailable = () => props.deployment?.provider === null;
  const providers = () => (providersQuery.data ?? []).filter((p) => p.isEnabled);
  const providerOptions = () =>
    providers().map((p) => ({ value: p.id, label: `${p.name} (${p.type})` }));

  createEffect(() => {
    if (!props.open) return;
    setErrors({});
    setValues(props.deployment ? valuesFromDeployment(props.deployment) : emptyValues);
  });

  const setField = (key: keyof ModelFormValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = (event: Event) => {
    event.preventDefault();
    const parsed = modelFormSchema.safeParse(values());
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const v = parsed.data;
    const hasPricing = v.inputPrice !== "" || v.outputPrice !== "";
    props.onSubmit({
      modelName: v.modelName,
      providerId: v.providerId,
      providerModel: v.providerModel,
      modelInfo: hasPricing
        ? {
            inputPrice: v.inputPrice ? Number(v.inputPrice) : undefined,
            outputPrice: v.outputPrice ? Number(v.outputPrice) : undefined,
          }
        : null,
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit() ? "Edit Deployment" : "Add Deployment"}</DialogTitle>
          <DialogDescription>
            Map a public model alias to a provider&apos;s model.
          </DialogDescription>
        </DialogHeader>

        <Form errors={errors()} onSubmit={handleSubmit} class="space-y-4">
          <FormField name="modelName">
            <FormItem>
              <FormLabel>Model Alias</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. gpt-4o"
                  value={values().modelName}
                  onInput={(e) => setField("modelName", e.currentTarget.value)}
                />
              </FormControl>
              <FormDescription>The name clients use in their requests.</FormDescription>
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField name="providerId">
            <FormItem>
              <FormLabel>Provider</FormLabel>
              <FormControl>
                <Select
                  value={values().providerId}
                  onChange={(value) => setField("providerId", value)}
                  placeholder="Select provider…"
                  options={providerOptions()}
                />
              </FormControl>
              {providerUnavailable() && !values().providerId && (
                <FormDescription class="text-warning">
                  The original provider is unavailable. Select a provider from this project before
                  saving.
                </FormDescription>
              )}
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField name="providerModel">
            <FormItem>
              <FormLabel>Provider Model</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. gpt-4o-2024-08-06"
                  value={values().providerModel}
                  onInput={(e) => setField("providerModel", e.currentTarget.value)}
                />
              </FormControl>
              <FormDescription>The actual model ID sent to the provider.</FormDescription>
              <FormMessage />
            </FormItem>
          </FormField>

          <div class="grid grid-cols-2 gap-3">
            <FormField name="inputPrice">
              <FormItem>
                <FormLabel>Input Price ($/1M)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Optional"
                    value={values().inputPrice}
                    onInput={(e) => setField("inputPrice", e.currentTarget.value)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            </FormField>
            <FormField name="outputPrice">
              <FormItem>
                <FormLabel>Output Price ($/1M)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Optional"
                    value={values().outputPrice}
                    onInput={(e) => setField("outputPrice", e.currentTarget.value)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            </FormField>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <Button type="button" variant="default" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={props.isPending}
              busy={props.isPending}
            >
              {props.isPending ? <Loader2 class="h-4 w-4 animate-spin" size={16} /> : null}
              {isEdit() ? "Save" : "Create"}
            </Button>
          </div>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
