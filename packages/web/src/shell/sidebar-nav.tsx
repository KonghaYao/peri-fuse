import { ProjectSidebarShell } from "@peri/ui";
import { A, useLocation } from "@solidjs/router";
import { Database, Menu, Moon, PanelLeftClose, PanelLeftOpen, Settings, Sun } from "lucide-solid";
import { type Component, For, Show } from "solid-js";
import { cn } from "@/shared/lib/utils";
import { hasActiveProject } from "@/shared/store/project";
import { toggleSidebarCollapsed, useSidebarCollapsed } from "@/shared/store/sidebar";
import { toggleTheme, useTheme } from "@/shared/store/theme";
import { CommandPaletteTrigger } from "./command-palette-trigger";
import { gatewayNavItems, type NavItem, observabilityNavItems } from "./nav-items";
import { ProjectSwitcher } from "./project-switcher";

function BrandMark(props: { size?: number }) {
  const size = () => props.size ?? 28;
  return (
    <div
      class="flex shrink-0 items-center justify-center rounded-md bg-brand"
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      <Database class="text-brand-fg" size={size() * 0.57} />
    </div>
  );
}

function NavLinkItem(props: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const location = useLocation();
  const isActive = () => {
    const path = location.pathname;
    if (props.item.href === "/gateway") return path === "/gateway";
    return path === props.item.href || path.startsWith(`${props.item.href}/`);
  };

  return (
    <A
      href={props.item.href}
      title={props.collapsed ? props.item.label : undefined}
      onClick={() => props.onNavigate?.()}
      class={cn(
        "relative flex h-8 items-center gap-2.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-150",
        props.collapsed && "justify-center px-0",
        isActive()
          ? "bg-brand-subtle text-brand"
          : "text-fg-secondary hover:bg-surface-overlay/70 hover:text-fg-primary",
      )}
    >
      <Show when={isActive()}>
        <span class="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-brand" />
      </Show>
      <props.item.icon class="h-4 w-4 shrink-0" size={16} strokeWidth={1.75} />
      <Show when={!props.collapsed}>
        <span class="truncate">{props.item.label}</span>
      </Show>
    </A>
  );
}

export const SidebarNav: Component<{ onNavigate?: () => void }> = (props) => {
  const collapsed = useSidebarCollapsed();
  const theme = useTheme();
  const active = () => hasActiveProject();

  const navbar = (
    <div class="flex flex-col gap-2">
      <div
        class={cn(
          "flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border px-3",
          collapsed() && "justify-center px-0",
        )}
      >
        <BrandMark />
        <Show when={!collapsed()}>
          <span class="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg-primary">
            Peri-Fuse
            <span class="ml-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-fg-tertiary">
              Lite
            </span>
          </span>
        </Show>
      </div>
      <div class="border-b border-border px-2 py-2">
        <ProjectSwitcher collapsed={collapsed()} onNavigate={props.onNavigate} />
      </div>
      <Show when={!collapsed()}>
        <div class="px-2 pb-2">
          <CommandPaletteTrigger />
        </div>
      </Show>
    </div>
  );

  const body = (
    <div class="space-y-0.5">
      <Show when={active()}>
        <Show when={!collapsed()}>
          <p class="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
            Observability
          </p>
        </Show>
        <For each={observabilityNavItems}>
          {(item) => (
            <NavLinkItem item={item} collapsed={collapsed()} onNavigate={props.onNavigate} />
          )}
        </For>
      </Show>
      <Show when={!collapsed()}>
        <p class="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
          Gateway
        </p>
      </Show>
      <Show when={collapsed()}>
        <div class="my-2 border-t border-border" />
      </Show>
      <For each={gatewayNavItems}>
        {(item) => (
          <NavLinkItem item={item} collapsed={collapsed()} onNavigate={props.onNavigate} />
        )}
      </For>
    </div>
  );

  const footer = (
    <div class="w-full space-y-0.5">
      <Show when={active()}>
        <NavLinkItem
          item={{ href: "/settings", label: "Settings", icon: Settings }}
          collapsed={collapsed()}
          onNavigate={props.onNavigate}
        />
      </Show>
      <button
        type="button"
        onClick={toggleTheme}
        title={theme() === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        class={cn(
          "flex h-8 w-full items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-fg-secondary transition-colors duration-150 hover:bg-surface-overlay/70 hover:text-fg-primary",
          collapsed() && "justify-center px-0",
        )}
      >
        <Show when={theme() === "dark"} fallback={<Moon class="h-4 w-4 shrink-0" size={16} />}>
          <Sun class="h-4 w-4 shrink-0" size={16} strokeWidth={1.75} />
        </Show>
        <Show when={!collapsed()}>
          <span>{theme() === "dark" ? "Light mode" : "Dark mode"}</span>
        </Show>
      </button>
      <button
        type="button"
        onClick={toggleSidebarCollapsed}
        title={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
        class={cn(
          "hidden h-8 w-full items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-fg-secondary transition-colors duration-150 hover:bg-surface-overlay/70 hover:text-fg-primary md:flex",
          collapsed() && "justify-center px-0",
        )}
      >
        <Show
          when={collapsed()}
          fallback={<PanelLeftClose class="h-4 w-4 shrink-0" size={16} strokeWidth={1.75} />}
        >
          <PanelLeftOpen class="h-4 w-4 shrink-0" size={16} strokeWidth={1.75} />
        </Show>
        <Show when={!collapsed()}>
          <span>Collapse sidebar</span>
        </Show>
      </button>
    </div>
  );

  return (
    <ProjectSidebarShell
      class="h-full border-r border-border bg-surface-raised"
      navbar={navbar}
      body={body}
      footer={footer}
      aria-label="Main navigation"
    />
  );
};

export { BrandMark, Menu };
