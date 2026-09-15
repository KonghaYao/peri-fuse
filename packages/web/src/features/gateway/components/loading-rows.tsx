import { Skeleton } from "@peri/ui";
import { type Component, For } from "solid-js";

export const LoadingRows: Component<{ rows?: number }> = (props) => {
  const count = () => props.rows ?? 4;
  const indices = () => Array.from({ length: count() }, (_, i) => i);

  return (
    <div class="space-y-8" role="status" aria-live="polite">
      <For each={indices()}>{() => <Skeleton class="h-36 w-full" />}</For>
    </div>
  );
};
