import { IoTabsShell, IoViewer } from "@peri/ui";
import { type Component, createMemo } from "solid-js";
import { ObservationPreview } from "@/shared/components/observations/observation-preview";
import type { Observation } from "@/shared/lib/types";

export const ObservationIoTabs: Component<{
  observation?: Observation;
  input: unknown;
  output: unknown;
  metadata: unknown;
}> = (props) => {
  const observation = () => props.observation;
  const input = createMemo(() => props.input);
  const output = createMemo(() => props.output);
  const metadata = createMemo(() => props.metadata);

  return (
    <IoTabsShell
      showPreviewTab={Boolean(observation())}
      defaultTab={observation() ? "preview" : "input"}
      renderPreview={() =>
        observation() ? <ObservationPreview observation={observation()!} /> : null
      }
      renderInput={() => <IoViewer data={input} />}
      renderOutput={() => <IoViewer data={output} />}
      renderMetadata={() => <IoViewer data={metadata} defaultMode="json" />}
    />
  );
};
