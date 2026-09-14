/**
 * Titled card wrapper for dashboard charts with a consistent empty state.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@peri/ui";
import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";
import { cn } from "@/shared/lib/utils";

export function ChartCard(props: {
  title: string;
  description?: string;
  isEmpty: boolean;
  emptyMessage?: string;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <Card class={cn("flex flex-col", props.class)}>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <Show when={props.description}>
          <CardDescription>{props.description}</CardDescription>
        </Show>
      </CardHeader>
      <CardContent class="flex-1">
        <Show
          when={!props.isEmpty}
          fallback={
            <p class="py-16 text-center text-sm text-fg-tertiary">
              {props.emptyMessage ?? "No data in the selected range."}
            </p>
          }
        >
          {props.children}
        </Show>
      </CardContent>
    </Card>
  );
}
