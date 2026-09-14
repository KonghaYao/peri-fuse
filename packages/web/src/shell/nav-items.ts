import {
  Activity,
  BarChart3,
  Boxes,
  Gauge,
  LayoutDashboard,
  ListTree,
  ScrollText,
  Server,
  ShieldAlert,
  Star,
  UserRound,
  Users,
} from "lucide-solid";
import type { Component } from "solid-js";

export type NavItem = {
  href: string;
  label: string;
  icon: Component<{ class?: string; size?: number; strokeWidth?: number }>;
};

export const observabilityNavItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/traces", label: "Traces", icon: ListTree },
  { href: "/errors", label: "Errors", icon: ShieldAlert },
  { href: "/sessions", label: "Sessions", icon: Users },
  { href: "/users", label: "Users", icon: UserRound },
  { href: "/observations", label: "Observations", icon: Activity },
  { href: "/scores", label: "Scores", icon: Star },
];

export const gatewayNavItems: NavItem[] = [
  { href: "/gateway", label: "Overview", icon: LayoutDashboard },
  { href: "/gateway/providers", label: "Providers", icon: Server },
  { href: "/gateway/models", label: "Models", icon: Boxes },
  { href: "/gateway/usage", label: "Usage", icon: BarChart3 },
  { href: "/gateway/logs", label: "Logs", icon: ScrollText },
];
