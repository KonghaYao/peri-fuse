import type { CommandPaletteItem } from "@peri/ui";
import {
  Activity,
  Gauge,
  ListTree,
  Moon,
  Settings,
  ShieldAlert,
  Star,
  Sun,
  UserRound,
  Users,
} from "lucide-solid";
import type { Theme } from "@/shared/store/theme";

type PaletteNavDef = {
  id: string;
  label: string;
  href: string;
  keywords: string;
  icon: typeof Gauge;
};

const NAV_COMMANDS: PaletteNavDef[] = [
  {
    id: "dashboard",
    label: "Go to Dashboard",
    href: "/dashboard",
    keywords: "dashboard home overview stats",
    icon: Gauge,
  },
  {
    id: "traces",
    label: "Go to Traces",
    href: "/traces",
    keywords: "traces spans llm calls",
    icon: ListTree,
  },
  {
    id: "errors",
    label: "Investigate Errors",
    href: "/errors",
    keywords: "errors failures incidents exceptions root cause debug",
    icon: ShieldAlert,
  },
  {
    id: "sessions",
    label: "Go to Sessions",
    href: "/sessions",
    keywords: "sessions conversations threads",
    icon: Users,
  },
  {
    id: "users",
    label: "Go to Users",
    href: "/users",
    keywords: "users people accounts usage",
    icon: UserRound,
  },
  {
    id: "observations",
    label: "Go to Observations",
    href: "/observations",
    keywords: "observations generations spans events",
    icon: Activity,
  },
  {
    id: "scores",
    label: "Go to Scores",
    href: "/scores",
    keywords: "scores evaluations ratings",
    icon: Star,
  },
  {
    id: "settings",
    label: "Go to Settings",
    href: "/settings",
    keywords: "settings api keys configuration",
    icon: Settings,
  },
];

export function buildCommandPaletteItems(options: {
  navigate: (path: string) => void;
  hasProject: boolean;
  theme: Theme;
  onToggleTheme: () => void;
}): CommandPaletteItem[] {
  const nav: CommandPaletteItem[] = options.hasProject
    ? NAV_COMMANDS.map((cmd) => ({
        id: cmd.id,
        label: cmd.label,
        keywords: cmd.keywords,
        icon: <cmd.icon size={14} strokeWidth={1.75} />,
        onSelect: () => options.navigate(cmd.href),
      }))
    : [];

  const actions: CommandPaletteItem[] = [
    {
      id: "theme",
      label: options.theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode",
      hint: "Appearance",
      keywords: "theme dark light appearance mode toggle",
      icon:
        options.theme === "dark" ? (
          <Sun size={14} strokeWidth={1.75} />
        ) : (
          <Moon size={14} strokeWidth={1.75} />
        ),
      onSelect: options.onToggleTheme,
    },
  ];

  return [...nav, ...actions];
}
