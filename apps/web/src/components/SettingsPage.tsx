import type { ConnectionState, ProjectSummary } from "@anvil/protocol";
import {
  AiSettingIcon,
  ArrowLeft01Icon,
  ComputerIcon,
  DatabaseSettingIcon,
  Folder01Icon,
  InformationCircleIcon,
  Moon02Icon,
  Notification01Icon,
  PaintBoardIcon,
  RefreshIcon,
  SecurityCheckIcon,
  ServerStack01Icon,
  Settings01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";

type SettingsSection = "general" | "pi" | "workspaces" | "notifications" | "forge" | "advanced";
type ThemePreference = "system" | "light" | "dark";

interface SettingsPageProps {
  connection: ConnectionState;
  projects: ProjectSummary[];
  theme: ThemePreference;
  onClose: () => void;
}

const sections = [
  { id: "general", label: "General", icon: Settings01Icon },
  { id: "pi", label: "Pi", icon: AiSettingIcon },
  { id: "workspaces", label: "Workspaces", icon: Folder01Icon },
  { id: "notifications", label: "Notifications", icon: Notification01Icon },
  { id: "forge", label: "Forge", icon: ServerStack01Icon },
  { id: "advanced", label: "Advanced", icon: DatabaseSettingIcon },
] as const;

function PreviewSwitch({ checked, label }: { checked: boolean; label: string }) {
  return (
    <button
      type="button"
      className="settings-switch"
      data-state={checked ? "checked" : "unchecked"}
      aria-label={label}
      aria-pressed={checked}
      title="Visual preview only"
      disabled
    >
      <span />
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
  align = "center",
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div className={`settings-row settings-row--${align}`}>
      <div className="settings-row-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      <div className="settings-group-heading">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-group-panel">{children}</div>
    </section>
  );
}

function GeneralSettings({ theme }: Pick<SettingsPageProps, "theme">) {
  return (
    <>
      <SettingsGroup title="Appearance" description="Keep ocode comfortable across every device.">
        <SettingRow title="Theme" description="Choose how the interface looks on this device." align="start">
          <div className="settings-theme-picker" role="group" aria-label="Theme">
            {([
              ["system", "System", ComputerIcon],
              ["light", "Light", Sun03Icon],
              ["dark", "Dark", Moon02Icon],
            ] as const).map(([value, label, icon]) => (
              <button
                key={value}
                type="button"
                className={theme === value ? "is-active" : undefined}
                aria-pressed={theme === value}
                title="Visual preview only"
                disabled
              >
                <HugeiconsIcon icon={icon} strokeWidth={1.8} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow title="Interface density" description="Adjust the spacing of threads, tools, and controls.">
          <Select value="comfortable" disabled>
            <SelectTrigger className="settings-select"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="comfortable">Comfortable</SelectItem>
              <SelectItem value="relaxed">Relaxed</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Startup">
        <SettingRow title="Resume last thread" description="Open the most recently viewed thread when ocode starts.">
          <PreviewSwitch checked label="Resume last thread" />
        </SettingRow>
        <SettingRow title="Confirm destructive actions" description="Ask before deleting threads, workspaces, or cached data.">
          <PreviewSwitch checked label="Confirm destructive actions" />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}

function PiSettings() {
  return (
    <>
      <SettingsGroup title="Session defaults" description="Defaults apply when a new Pi thread is created.">
        <SettingRow title="Model" description="Use Pi's configured model unless a thread overrides it.">
          <Select value="pi-default" disabled>
            <SelectTrigger className="settings-select settings-select--wide"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="pi-default">Configured by Pi</SelectItem>
              <SelectItem value="last-used">Last used model</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="Thinking level" description="Set the reasoning depth for new threads.">
          <Select value="medium" disabled>
            <SelectTrigger className="settings-select"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="xhigh">Extra high</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="Show reasoning" description="Display reasoning events in the conversation timeline.">
          <PreviewSwitch checked label="Show reasoning" />
        </SettingRow>
        <SettingRow title="Expand tool details" description="Open tool inputs and outputs automatically while Pi works.">
          <PreviewSwitch checked={false} label="Expand tool details" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Capabilities" description="Pi loads these from your normal Forge configuration.">
        <div className="settings-capability-summary">
          <div><span>Commands</span><strong>Dynamic</strong></div>
          <div><span>Skills</span><strong>Dynamic</strong></div>
          <div><span>Extensions</span><strong>Enabled</strong></div>
        </div>
      </SettingsGroup>
    </>
  );
}

function WorkspaceSettings({ projects }: Pick<SettingsPageProps, "projects">) {
  return (
    <>
      <SettingsGroup title="Trusted workspaces" description="Forge can only access paths explicitly trusted here.">
        <div className="settings-workspace-list">
          {projects.map((project) => (
            <div className="settings-workspace" key={project.id}>
              <span className="settings-workspace-icon"><HugeiconsIcon icon={Folder01Icon} strokeWidth={1.8} /></span>
              <span className="settings-workspace-copy">
                <strong>{project.name}</strong>
                <small>{project.path}</small>
              </span>
              <span className="settings-trust-badge"><HugeiconsIcon icon={SecurityCheckIcon} strokeWidth={2} />Trusted</span>
              <Button variant="ghost" size="sm" disabled>Manage</Button>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="settings-empty-row">No trusted workspaces have been added.</div>
          )}
        </div>
        <div className="settings-panel-footer">
          <Button variant="outline" size="sm" disabled><HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />Add workspace</Button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Workspace behavior">
        <SettingRow title="Default workspace" description="Choose where the new-thread action starts.">
          <Select value="last-used" disabled>
            <SelectTrigger className="settings-select settings-select--wide"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="last-used">Last used workspace</SelectItem>
              {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="Remember workspace layout" description="Restore open terminals and file previews per workspace.">
          <PreviewSwitch checked label="Remember workspace layout" />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}

function NotificationSettings() {
  return (
    <>
      <SettingsGroup title="Thread activity" description="Choose when ocode should get your attention.">
        <SettingRow title="Thread completed" description="Notify when Pi finishes while ocode is in the background.">
          <PreviewSwitch checked label="Thread completed notifications" />
        </SettingRow>
        <SettingRow title="Input required" description="Notify when Pi is waiting for an answer or approval.">
          <PreviewSwitch checked label="Input required notifications" />
        </SettingRow>
        <SettingRow title="Thread failed" description="Notify when a run or Forge command ends unexpectedly.">
          <PreviewSwitch checked label="Thread failed notifications" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Delivery">
        <SettingRow title="Browser notifications" description="Allow system notifications when this tab is not visible.">
          <span className="settings-status-label">Available</span>
        </SettingRow>
        <SettingRow title="Sound" description="Play a restrained alert for high-priority events.">
          <PreviewSwitch checked={false} label="Notification sounds" />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}

function ForgeSettings({ connection }: Pick<SettingsPageProps, "connection">) {
  const connected = connection === "connected";
  const connectionLabel = connection === "offline" ? "Offline" : connected ? "Connected" : "Reconnecting";
  return (
    <>
      <div className="settings-runtime-card">
        <div className="settings-runtime-mark"><HugeiconsIcon icon={ServerStack01Icon} strokeWidth={1.7} /></div>
        <div>
          <span className={`settings-runtime-state ${connected ? "is-connected" : ""}`}><i />{connectionLabel}</span>
          <h3>Forge runtime</h3>
          <p>Pi sessions continue running on Forge when every client disconnects.</p>
        </div>
        <Button variant="outline" size="sm" disabled>View diagnostics</Button>
      </div>

      <SettingsGroup title="Runtime information">
        <SettingRow title="Transport" description="Private client connection to the Forge service.">
          <span className="settings-code-value">Tailscale HTTPS</span>
        </SettingRow>
        <SettingRow title="Pi configuration" description="Uses the normal Pi installation and configuration on Forge.">
          <span className="settings-status-label">Loaded</span>
        </SettingRow>
        <SettingRow title="Session persistence" description="Threads remain active independently of this browser.">
          <span className="settings-status-label settings-status-label--success">Active</span>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Web interface" description="Apply the latest frontend changes without interrupting running threads.">
        <div className="settings-action-row">
          <div>
            <strong>Rebuild ocode</strong>
            <p>Build the latest React changes, then reload this client.</p>
          </div>
          <Button size="sm" disabled><HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />Rebuild</Button>
        </div>
      </SettingsGroup>
    </>
  );
}

function AdvancedSettings() {
  return (
    <>
      <SettingsGroup title="Session data">
        <SettingRow title="Settled thread retention" description="Control how long settled thread metadata remains visible.">
          <Select value="forever" disabled>
            <SelectTrigger className="settings-select"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="30-days">30 days</SelectItem>
              <SelectItem value="90-days">90 days</SelectItem>
              <SelectItem value="forever">Forever</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="Retain event journal" description="Keep sequenced events for reliable reconnection and restoration.">
          <PreviewSwitch checked label="Retain event journal" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Diagnostics">
        <div className="settings-action-row">
          <div><strong>Export diagnostics</strong><p>Download client, runtime, and protocol details for troubleshooting.</p></div>
          <Button variant="outline" size="sm" disabled>Export</Button>
        </div>
        <div className="settings-action-row">
          <div><strong>Clear local client state</strong><p>Remove cached interface state from this browser only.</p></div>
          <Button variant="outline" size="sm" disabled>Clear</Button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <div className="settings-action-row settings-action-row--danger">
          <div><strong>Reset settings</strong><p>Restore all ocode preferences to their defaults.</p></div>
          <Button variant="destructive" size="sm" disabled>Reset settings</Button>
        </div>
      </SettingsGroup>
    </>
  );
}

const sectionCopy: Record<SettingsSection, { title: string; description: string; icon: typeof Settings01Icon }> = {
  general: { title: "General", description: "Appearance, startup, and everyday interface preferences.", icon: PaintBoardIcon },
  pi: { title: "Pi", description: "Choose the defaults ocode uses for new Pi sessions.", icon: AiSettingIcon },
  workspaces: { title: "Workspaces", description: "Manage the trusted projects Forge is allowed to access.", icon: Folder01Icon },
  notifications: { title: "Notifications", description: "Decide how ocode lets you know when a thread needs attention.", icon: Notification01Icon },
  forge: { title: "Forge", description: "Inspect the remote runtime that owns your persistent Pi sessions.", icon: ServerStack01Icon },
  advanced: { title: "Advanced", description: "Retention, diagnostics, and recovery controls.", icon: InformationCircleIcon },
};

export function SettingsPage(props: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const current = sectionCopy[activeSection];

  return (
    <div className="settings-page">
      <header className="session-header settings-page-header">
        <div className="header-title-group">
          <SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar" />
          <div className="session-heading"><h1>Settings</h1></div>
        </div>
        <Button variant="ghost" size="sm" aria-label="Back to thread" data-settings-back onClick={props.onClose}>
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          <span>Back to thread</span>
        </Button>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-heading">Preferences</div>
          <div className="settings-nav-items">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={activeSection === section.id ? "is-active" : undefined}
                aria-current={activeSection === section.id ? "page" : undefined}
                onClick={() => setActiveSection(section.id)}
              >
                <HugeiconsIcon icon={section.icon} strokeWidth={1.8} />
                <span>{section.label}</span>
              </button>
            ))}
          </div>
          <div className="settings-nav-note">
            <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.8} />
            <p>Preferences are private to your Forge installation.</p>
          </div>
        </nav>

        <main className="settings-content" key={activeSection}>
          <div className="settings-content-inner">
            <div className="settings-content-header">
              <span><HugeiconsIcon icon={current.icon} strokeWidth={1.7} /></span>
              <div><h2>{current.title}</h2><p>{current.description}</p></div>
            </div>

            {activeSection === "general" && <GeneralSettings theme={props.theme} />}
            {activeSection === "pi" && <PiSettings />}
            {activeSection === "workspaces" && <WorkspaceSettings projects={props.projects} />}
            {activeSection === "notifications" && <NotificationSettings />}
            {activeSection === "forge" && <ForgeSettings connection={props.connection} />}
            {activeSection === "advanced" && <AdvancedSettings />}

            <footer className="settings-content-footer">
              <span>Settings preview</span>
              <span>Controls are not connected</span>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
