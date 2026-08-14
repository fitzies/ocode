import {
  ComputerIcon,
  Folder01Icon,
  Moon02Icon,
  RefreshIcon,
  Settings01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

import type { Accent } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type MessageFontSize = "small" | "default" | "large" | "extra-large";
export type MessageWidth = "narrow" | "full";
export type InterfaceFont = "system" | "inter" | "geist";

export type DisplayPreferences = {
  fontFamily: InterfaceFont;
  fontSize: MessageFontSize;
  width: MessageWidth;
};

export const ACCENT_OPTIONS: Array<{ value: Accent; label: string; swatch: string }> = [
  { value: "neutral", label: "Neutral", swatch: "bg-neutral-300 dark:bg-neutral-200" },
  { value: "blue", label: "Blue", swatch: "bg-blue-400" },
  { value: "cyan", label: "Cyan", swatch: "bg-cyan-400" },
  { value: "emerald", label: "Emerald", swatch: "bg-emerald-400" },
  { value: "amber", label: "Amber", swatch: "bg-amber-400" },
  { value: "rose", label: "Rose", swatch: "bg-rose-400" },
  { value: "pink", label: "Pink", swatch: "bg-pink-400" },
  { value: "purple", label: "Purple", swatch: "bg-purple-400" },
];

function SettingsSection({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3" aria-labelledby={`settings-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <div className="grid gap-1 px-1">
        <h2 id={`settings-${title.toLowerCase().replaceAll(" ", "-")}`} className="text-sm font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ItemGroup className="gap-0 overflow-hidden rounded-lg border bg-card">
        {children}
      </ItemGroup>
    </section>
  );
}

function SettingsItem({ icon, title, description, control }: {
  icon: ReactNode;
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <Item className="rounded-none border-0 px-4 py-3.5 first:rounded-t-lg last:rounded-b-lg">
      <ItemMedia variant="icon" className="text-muted-foreground">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">{control}</ItemActions>
    </Item>
  );
}

function RowSeparator() {
  return <Separator className="ml-11 w-[calc(100%-2.75rem)]" />;
}

export function SettingsPage({
  theme,
  accent,
  displayPreferences,
  desktopClient,
  rebuildState,
  onThemeChange,
  onAccentChange,
  onDisplayPreferencesChange,
  onOpenShortcuts,
  onManageProjects,
  onProjectsRoot,
  onDesktopUpdates,
  onRebuild,
}: {
  theme: "system" | "light" | "dark";
  accent: Accent;
  displayPreferences: DisplayPreferences;
  desktopClient: boolean;
  rebuildState: "idle" | "rebuilding";
  onThemeChange: (theme: "system" | "light" | "dark") => void;
  onAccentChange: (accent: Accent) => void;
  onDisplayPreferencesChange: (preferences: DisplayPreferences) => void;
  onOpenShortcuts: () => void;
  onManageProjects: () => void;
  onProjectsRoot: () => void;
  onDesktopUpdates: () => void;
  onRebuild: () => void;
}) {
  const selectedAccent = ACCENT_OPTIONS.find((option) => option.value === accent) ?? ACCENT_OPTIONS[0]!;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="session-header" data-tauri-drag-region="deep">
        <div className="header-title-group">
          <SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar" />
          <div className="session-heading"><h1>Settings</h1></div>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto grid w-full max-w-3xl gap-9 px-4 py-8 sm:px-8 sm:py-10">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">Personalize ocode and manage this Forge runtime.</p>
          </div>

          <SettingsSection title="Appearance" description="Choose how ocode looks and how conversations are laid out.">
            <SettingsItem
              icon={<HugeiconsIcon icon={theme === "dark" ? Moon02Icon : theme === "light" ? Sun03Icon : ComputerIcon} strokeWidth={2} />}
              title="Theme"
              description="Use your system appearance or choose a fixed theme."
              control={
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={0}
                  value={theme}
                  onValueChange={(value) => value && onThemeChange(value as "system" | "light" | "dark")}
                  aria-label="Theme"
                  className="w-full sm:w-auto"
                >
                  <ToggleGroupItem value="system" aria-label="System theme" className="flex-1 sm:flex-none"><HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />System</ToggleGroupItem>
                  <ToggleGroupItem value="light" aria-label="Light theme" className="flex-1 sm:flex-none"><HugeiconsIcon icon={Sun03Icon} strokeWidth={2} />Light</ToggleGroupItem>
                  <ToggleGroupItem value="dark" aria-label="Dark theme" className="flex-1 sm:flex-none"><HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />Dark</ToggleGroupItem>
                </ToggleGroup>
              }
            />
            <RowSeparator />
            <SettingsItem
              icon={<span className={`size-3 rounded-full ring-1 ring-black/10 ${selectedAccent.swatch}`} />}
              title="Accent"
              description="Set the highlight color used for active controls and focus."
              control={
                <Select value={accent} onValueChange={(value) => onAccentChange(value as Accent)}>
                  <SelectTrigger className="w-full sm:w-40" aria-label="Accent color">
                    <SelectValue><span className={`size-2.5 rounded-full ring-1 ring-black/10 ${selectedAccent.swatch}`} />{selectedAccent.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ACCENT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <span className={`size-2.5 rounded-full ring-1 ring-black/10 ${option.swatch}`} />{option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <RowSeparator />
            <SettingsItem
              icon={<span className="font-mono text-xs font-semibold">Aa</span>}
              title="Interface font"
              description="Choose the typeface used throughout the app."
              control={
                <Select value={displayPreferences.fontFamily} onValueChange={(fontFamily) => onDisplayPreferencesChange({ ...displayPreferences, fontFamily: fontFamily as InterfaceFont })}>
                  <SelectTrigger className="w-full sm:w-40" aria-label="Interface font"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="inter">Inter</SelectItem>
                    <SelectItem value="geist">Geist</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <RowSeparator />
            <SettingsItem
              icon={<span className="text-xs font-semibold">T</span>}
              title="Message text size"
              description="Adjust the reading size of conversation messages."
              control={
                <Select value={displayPreferences.fontSize} onValueChange={(fontSize) => onDisplayPreferencesChange({ ...displayPreferences, fontSize: fontSize as MessageFontSize })}>
                  <SelectTrigger className="w-full sm:w-40" aria-label="Message text size"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Small</SelectItem>
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="large">Large</SelectItem>
                    <SelectItem value="extra-large">Extra large</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <RowSeparator />
            <SettingsItem
              icon={<span className="font-mono text-xs">↔</span>}
              title="Message width"
              description="Keep messages focused or let them use more of the workspace."
              control={
                <Select value={displayPreferences.width} onValueChange={(width) => onDisplayPreferencesChange({ ...displayPreferences, width: width as MessageWidth })}>
                  <SelectTrigger className="w-full sm:w-40" aria-label="Message width"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="narrow">Normal</SelectItem>
                    <SelectItem value="full">Full</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
          </SettingsSection>

          <SettingsSection title="Workspace" description="Manage projects and the shortcuts used to move around ocode.">
            <SettingsItem
              icon={<HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />}
              title="Projects"
              description="Review connected workspaces or change where new projects are created."
              control={<div className="flex w-full gap-2 sm:w-auto"><Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onManageProjects}>Manage</Button><Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onProjectsRoot}>Projects root</Button></div>}
            />
            <RowSeparator />
            <SettingsItem
              icon={<span className="text-sm leading-none" aria-hidden="true">⌨</span>}
              title="Keyboard shortcuts"
              description="See the shortcuts available for threads, files, terminals, and navigation."
              control={<Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={onOpenShortcuts}>View shortcuts</Button>}
            />
          </SettingsSection>

          <SettingsSection title="Maintenance" description="Keep this client up to date without interrupting running threads.">
            {desktopClient && (
              <>
                <SettingsItem
                  icon={<HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />}
                  title="Desktop updates"
                  description="Check for and install updates to the ocode desktop app."
                  control={<Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={onDesktopUpdates}>Check for updates</Button>}
                />
                <RowSeparator />
              </>
            )}
            <SettingsItem
              icon={<HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />}
              title="Web app"
              description="Build the latest interface and reload this client. Running threads continue on Forge."
              control={<Button variant="outline" size="sm" className="w-full sm:w-auto" disabled={rebuildState === "rebuilding"} onClick={onRebuild}>{rebuildState === "rebuilding" ? "Rebuilding…" : "Rebuild web app"}</Button>}
            />
          </SettingsSection>

          <div className="flex items-center gap-2 px-1 text-[0.6875rem] text-muted-foreground">
            <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} className="size-3.5" />
            Settings are stored on this device unless noted otherwise.
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
