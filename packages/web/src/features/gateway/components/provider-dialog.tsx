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
import type { GatewayProvider } from "@/shared/lib/gateway-api";

const providerFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  type: z.string().min(1, "Type is required"),
  baseUrl: z.string().trim().min(1, "Base URL is required").url("Must be a valid URL"),
  apiKey: z.string().trim(),
  budgetLimit: z.string().refine((v) => v === "" || !Number.isNaN(Number(v)), {
    message: "Must be a valid number",
  }),
  budgetPeriod: z.string().trim(),
});

type ProviderFormValues = z.infer<typeof providerFormSchema>;

const emptyValues: ProviderFormValues = {
  name: "",
  type: "openai",
  baseUrl: "",
  apiKey: "",
  budgetLimit: "",
  budgetPeriod: "",
};

function valuesFromProvider(provider: GatewayProvider): ProviderFormValues {
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: "",
    budgetLimit: provider.budgetLimit != null ? String(provider.budgetLimit) : "",
    budgetPeriod: provider.budgetPeriod ?? "",
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

export const ProviderDialog: Component<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider?: GatewayProvider | null;
  onSubmit: (body: {
    name: string;
    type: string;
    baseUrl: string;
    apiKey?: string;
    budgetLimit?: number | null;
    budgetPeriod?: string | null;
  }) => void;
  isPending: boolean;
}> = (props) => {
  const [values, setValues] = createSignal<ProviderFormValues>(emptyValues);
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const isEdit = () => Boolean(props.provider);

  createEffect(() => {
    if (!props.open) return;
    setErrors({});
    setValues(props.provider ? valuesFromProvider(props.provider) : emptyValues);
  });

  const setField = (key: keyof ProviderFormValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = (event: Event) => {
    event.preventDefault();
    const parsed = providerFormSchema.safeParse(values());
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const v = parsed.data;
    props.onSubmit({
      name: v.name,
      type: v.type,
      baseUrl: v.baseUrl,
      apiKey: v.apiKey || undefined,
      budgetLimit: v.budgetLimit ? Number(v.budgetLimit) : null,
      budgetPeriod: v.budgetPeriod || null,
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit() ? "Edit Provider" : "Add Provider"}</DialogTitle>
          <DialogDescription>
            {isEdit()
              ? "Update provider configuration."
              : "Connect an LLM provider to the gateway."}
          </DialogDescription>
        </DialogHeader>

        <Form errors={errors()} onSubmit={handleSubmit} class="space-y-4">
          <FormField name="name">
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. openai-prod"
                  value={values().name}
                  onInput={(e) => setField("name", e.currentTarget.value)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField name="type">
            <FormItem>
              <FormLabel>Type</FormLabel>
              <FormControl>
                <Select
                  value={values().type}
                  onChange={(value) => setField("type", value)}
                  options={[
                    { value: "openai", label: "OpenAI-compatible" },
                    { value: "anthropic", label: "Anthropic" },
                  ]}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField name="baseUrl">
            <FormItem>
              <FormLabel>Base URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://api.openai.com/v1"
                  value={values().baseUrl}
                  onInput={(e) => setField("baseUrl", e.currentTarget.value)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField name="apiKey">
            <FormItem>
              <FormLabel>
                API Key{" "}
                {isEdit() && (
                  <span class="font-normal text-fg-tertiary">(leave blank to keep current)</span>
                )}
              </FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder={isEdit() ? "••••••••" : "sk-..."}
                  value={values().apiKey}
                  onInput={(e) => setField("apiKey", e.currentTarget.value)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>

          <div class="grid grid-cols-2 gap-3">
            <FormField name="budgetLimit">
              <FormItem>
                <FormLabel>Budget Limit ($)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    placeholder="Optional"
                    value={values().budgetLimit}
                    onInput={(e) => setField("budgetLimit", e.currentTarget.value)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            </FormField>
            <FormField name="budgetPeriod">
              <FormItem>
                <FormLabel>Budget Period</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. 30d, 24h"
                    value={values().budgetPeriod}
                    onInput={(e) => setField("budgetPeriod", e.currentTarget.value)}
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
