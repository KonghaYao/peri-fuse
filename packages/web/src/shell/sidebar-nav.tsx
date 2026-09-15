import { A, useLocation } from "@solidjs/router";
import { Database, Moon, Settings, Sun } from "lucide-solid";
import { type Component, For, Show } from "solid-js";
import { cn } from "@/shared/lib/utils";
import { hasActiveProject } from "@/shared/store/project";
import { useSidebarCollapsed } from "@/shared/store/sidebar";
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
        "relative flex h-32 items-center gap-10 rounded-md px-12 text-[13px] font-medium transition-colors duration-150",
        props.collapsed && "justify-center px-0",
        isActive()
          ? "bg-brand-subtle text-brand"
          : "text-fg-secondary hover:bg-surface-overlay/70 hover:text-fg-primary",
      )}
    >
      <Show when={isActive()}>
        <span class="absolute bottom-6 left-0 top-6 w-2 rounded-full bg-brand" />
      </Show>
      <props.item.icon class="h-16 w-16 shrink-0" size={16} strokeWidth={1.75} />
      <Show when={!props.collapsed}>
        <span class="truncate">{props.item.label}</span>
      </Show>
    </A>
  );
}

/** Spectra §6.4 sidebar — flat raised surface, no peri-studio frost shell. */
export const SidebarNav: Component<{ onNavigate?: () => void }> = (props) => {
  const collapsed = useSidebarCollapsed();
  const theme = useTheme();
  const active = () => hasActiveProject();

  return (
    <div class="flex h-full flex-col border-r border-border bg-surface-raised">
      <div
        class={cn(
          "flex h-[52px] shrink-0 items-center gap-10 border-b border-border px-12",
          collapsed() && "justify-center px-0",
        )}
      >
        <BrandMark />
        <Show when={!collapsed()}>
          <span class="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg-primary">
            Peri-Fuse
            <span class="ml-6 text-[10px] font-medium uppercase tracking-[0.08em] text-fg-tertiary">
              Lite
            </span>
          </span>
        </Show>
      </div>

      <div class="shrink-0 border-b border-border p-8">
        <ProjectSwitcher collapsed={collapsed()} onNavigate={props.onNavigate} />
      </div>

      <Show when={!collapsed()}>
        <div class="shrink-0 px-8 pb-8">
          <CommandPaletteTrigger />
        </div>
      </Show>

      <nav class="flex-1 space-y-2 overflow-y-auto p-8">
        <Show when={active()}>
          <Show when={!collapsed()}>
            <p class="px-12 pb-4 pt-4 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
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
          <p class="px-12 pb-4 pt-12 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
            Gateway
          </p>
        </Show>
        <Show when={collapsed()}>
          <div class="my-8 border-t border-border" />
        </Show>
        <For each={gatewayNavItems}>
          {(item) => (
            <NavLinkItem item={item} collapsed={collapsed()} onNavigate={props.onNavigate} />
          )}
        </For>
      </nav>

      <div class="shrink-0 space-y-2 border-t border-border p-8">
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
            "flex h-32 w-full items-center gap-10 rounded-md px-12 text-[13px] font-medium text-fg-secondary transition-colors duration-150 hover:bg-surface-overlay/70 hover:text-fg-primary",
            collapsed() && "justify-center px-0",
          )}
        >
          <Show when={theme() === "dark"} fallback={<Moon class="h-16 w-16 shrink-0" size={16} />}>
            <Sun class="h-16 w-16 shrink-0" size={16} strokeWidth={1.75} />
          </Show>
          <Show when={!collapsed()}>
            <span>{theme() === "dark" ? "Light mode" : "Dark mode"}</span>
          </Show>
        </button>
      </div>
    </div>
  );
};

export { BrandMark };
