import {
  ComputerIcon,
  Folder01Icon,
  Moon02Icon,
  RefreshIcon,
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
  ItemTitle,
} from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type MessageFontSize = "small" | "default" | "large" | "extra-large";
export type MessageWidth = "full";
export type InterfaceFont = "system" | "inter" | "geist";

export type DisplayPreferences = {
  fontFamily: InterfaceFont;
  fontSize: MessageFontSize;
  width: MessageWidth;
};

export const ACCENT_OPTIONS: Array<{ value: Accent; label: string; swatch: string }> = [
  { value: "neutral", label: "Neutral", swatch: "bg-neutral-400 dark:bg-neutral-300" },
  { value: "blue", label: "Blue", swatch: "bg-blue-500" },
  { value: "cyan", label: "Cyan", swatch: "bg-cyan-500" },
  { value: "emerald", label: "Emerald", swatch: "bg-emerald-500" },
  { value: "amber", label: "Amber", swatch: "bg-amber-500" },
  { value: "rose", label: "Rose", swatch: "bg-rose-500" },
  { value: "pink", label: "Pink", swatch: "bg-pink-500" },
  { value: "purple", label: "Purple", swatch: "bg-purple-500" },
];

function SettingsSection({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const id = `settings-${title.toLowerCase().replaceAll(" ", "-")}`;

  return (
    <section className="space-y-3" aria-labelledby={id}>
      <div className="space-y-1 px-0.5">
        <h2 id={id} className="text-sm font-medium">{title}</h2>
        <p className="text-xs/relaxed text-muted-foreground">{description}</p>
      </div>
      <ItemGroup className="gap-0 border-y">
        {children}
      </ItemGroup>
    </section>
  );
}

function SettingsItem({ title, description, control, className }: {
  title: string;
  description: string;
  control: ReactNode;
  className?: string;
}) {
  return (
    <Item className={cn("rounded-none border-0 px-0 py-4 sm:flex-nowrap", className)}>
      <ItemContent className="min-w-0 pr-2">
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
      <ItemActions className="w-full shrink-0 sm:w-auto">{control}</ItemActions>
    </Item>
  );
}

function RowSeparator() {
  return <Separator />;
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
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="session-header" data-tauri-drag-region="deep">
        <div className="header-title-group">
          <SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar" />
          <div className="session-heading"><h1>Settings</h1></div>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
          <div className="space-y-10">
            <SettingsSection title="Appearance" description="Theme and color across ocode.">
              <SettingsItem
                title="Theme"
                description="Follow your device or choose a fixed appearance."
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
                title="Accent"
                description="Used for active controls, links, and focus."
                control={
                  <ToggleGroup
                    type="single"
                    value={accent}
                    onValueChange={(value) => value && onAccentChange(value as Accent)}
                    aria-label="Accent color"
                    className="grid w-full grid-cols-8 gap-1 sm:flex sm:w-auto"
                  >
                    {ACCENT_OPTIONS.map((option) => (
                      <ToggleGroupItem
                        key={option.value}
                        value={option.value}
                        aria-label={option.label}
                        title={option.label}
                        className="size-8 p-0"
                      >
                        <span className={cn("size-3.5 rounded-full ring-1 ring-black/10", option.swatch)} />
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                }
              />
            </SettingsSection>

            <SettingsSection title="Conversation" description="Reading comfort and message layout.">
              <SettingsItem
                title="Interface font"
                description="Typeface used throughout the app."
                control={
                  <Select value={displayPreferences.fontFamily} onValueChange={(fontFamily) => onDisplayPreferencesChange({ ...displayPreferences, fontFamily: fontFamily as InterfaceFont })}>
                    <SelectTrigger className="w-full sm:w-44" aria-label="Interface font"><SelectValue /></SelectTrigger>
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
                title="Message text"
                description="Reading size for conversation messages."
                control={
                  <Select value={displayPreferences.fontSize} onValueChange={(fontSize) => onDisplayPreferencesChange({ ...displayPreferences, fontSize: fontSize as MessageFontSize })}>
                    <SelectTrigger className="w-full sm:w-44" aria-label="Message text size"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="small">Small</SelectItem>
                      <SelectItem value="default">Default</SelectItem>
                      <SelectItem value="large">Large</SelectItem>
                      <SelectItem value="extra-large">Extra large</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />

            </SettingsSection>

            <SettingsSection title="Workspace" description="Projects and navigation.">
              <SettingsItem
                title="Projects"
                description="Manage connected workspaces and the projects root."
                control={<div className="flex w-full gap-2 sm:w-auto"><Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onManageProjects}><HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />Manage</Button><Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onProjectsRoot}>Projects root</Button></div>}
              />
              <RowSeparator />
              <SettingsItem
                title="Keyboard shortcuts"
                description="View shortcuts for threads, files, and navigation."
                control={<Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={onOpenShortcuts}>View shortcuts</Button>}
              />
            </SettingsSection>

            <SettingsSection title="Advanced" description="Updates and client maintenance.">
              {desktopClient && (
                <>
                  <SettingsItem
                    title="Desktop app"
                    description="Check for and install ocode updates."
                    control={<Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={onDesktopUpdates}>Check for updates</Button>}
                  />
                  <RowSeparator />
                </>
              )}
              <SettingsItem
                title="Web app"
                description="Rebuild and reload the interface. Running threads continue."
                control={<Button variant="outline" size="sm" className="w-full sm:w-auto" disabled={rebuildState === "rebuilding"} onClick={onRebuild}><HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />{rebuildState === "rebuilding" ? "Rebuilding…" : "Rebuild"}</Button>}
              />
            </SettingsSection>
          </div>

        </div>
      </ScrollArea>
    </div>
  );
}
