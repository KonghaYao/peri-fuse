import { Empty, EmptyDescription, EmptyHeader, EmptyTitle, PageHeaderShell } from "@peri/ui";
import type { Component } from "solid-js";

export type PlaceholderPageProps = {
  title: string;
  description?: string;
};

/** Phase 0 route shell — real pages replace these in later phases. */
export const PlaceholderPage: Component<PlaceholderPageProps> = (props) => {
  return (
    <div class="flex h-full flex-col">
      <PageHeaderShell title={props.title} description={props.description} />
      <div class="flex flex-1 items-center justify-center p-32">
        <Empty class="max-w-md">
          <EmptyHeader>
            <EmptyTitle>Coming soon</EmptyTitle>
            <EmptyDescription>
              {props.description ??
                "This page will be migrated in a later phase of the Solid rewrite."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
  );
};
