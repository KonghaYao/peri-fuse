import { IoTabsShell, IoViewer } from "@peri/ui";
import type { Component } from "solid-js";
import { ObservationPreview } from "@/shared/components/observations/observation-preview";
import type { Observation } from "@/shared/lib/types";

export const ObservationIoTabs: Component<{
  observation?: Observation;
  input: unknown;
  output: unknown;
  metadata: unknown;
}> = (props) => (
  <IoTabsShell
    showPreviewTab={Boolean(props.observation)}
    defaultTab={props.observation ? "preview" : "input"}
    renderPreview={() =>
      props.observation ? <ObservationPreview observation={props.observation} /> : null
    }
    renderInput={() => <IoViewer data={() => props.input} />}
    renderOutput={() => <IoViewer data={() => props.output} />}
    renderMetadata={() => <IoViewer data={() => props.metadata} defaultMode="json" />}
  />
);
