import type { ProjectGitConnectRequest, ProjectGitStatus } from "@anvil/protocol";
import { GithubIcon, InformationCircleIcon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, type Ref, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { connectProjectGit } from "@/lib/projectGit";

type ConnectionMode = "existing" | "github";

const CONNECTION_OPTIONS: ReadonlyArray<{
  value: ConnectionMode;
  title: string;
  description: string;
}> = [
  { value: "existing", title: "Use an existing remote", description: "Connect with an HTTPS or SSH Git URL" },
  { value: "github", title: "Create on GitHub", description: "Create a repository using Forge’s GitHub access" },
];

function ConnectionTypeChooser({
  mode,
  onModeChange,
  selectedRef,
}: {
  mode: ConnectionMode;
  onModeChange: (mode: ConnectionMode) => void;
  selectedRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <FieldGroup>
      <RadioGroup value={mode} onValueChange={(value) => onModeChange(value as ConnectionMode)} aria-label="Repository connection type">
        {CONNECTION_OPTIONS.map((option) => {
          const id = `repository-connection-${option.value}`;
          return (
            <FieldLabel key={option.value} htmlFor={id}>
              <Field orientation="horizontal">
                <FieldContent>
                  <div id={`${id}-label`} className="flex items-center gap-2 font-medium">
                    <HugeiconsIcon
                      icon={option.value === "github" ? GithubIcon : LinkSquare02Icon}
                      strokeWidth={1.8}
                      className="size-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    {option.title}
                  </div>
                  <FieldDescription id={`${id}-description`}>{option.description}</FieldDescription>
                </FieldContent>
                <RadioGroupItem
                  ref={option.value === mode ? selectedRef : undefined}
                  id={id}
                  value={option.value}
                  aria-labelledby={`${id}-label`}
                  aria-describedby={`${id}-description`}
                />
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>
      <FieldDescription>Repository operations run on Forge, not in this browser.</FieldDescription>
    </FieldGroup>
  );
}

export function ProjectGitConnectDialog({
  open,
  projectId,
  projectName,
  status,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  projectId: string;
  projectName: string;
  status: ProjectGitStatus;
  onOpenChange: (open: boolean) => void;
  onConnected: (status: ProjectGitStatus) => void;
}) {
  const choosesRemote = status.repositoryState === "ambiguous-remote";
  const [view, setView] = useState<"chooser" | "form">(choosesRemote ? "form" : "chooser");
  const [mode, setMode] = useState<ConnectionMode>("existing");
  const [remoteUrl, setRemoteUrl] = useState(choosesRemote ? status.remotes?.[0]?.name ?? "" : "");
  const [repository, setRepository] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const chooserRef = useRef<HTMLButtonElement>(null);
  const formTitleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setError(undefined);
    setView(choosesRemote ? "form" : "chooser");
    setMode("existing");
    setRemoteUrl(choosesRemote ? status.remotes?.[0]?.name ?? "" : "");
    setRepository("");
    setVisibility("private");
  }, [choosesRemote, open, projectId]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (view === "chooser") chooserRef.current?.focus();
      else formTitleRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, view]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const input: ProjectGitConnectRequest = choosesRemote
      ? { mode: "select", remoteName: remoteUrl }
      : mode === "existing"
        ? { mode, remoteUrl: remoteUrl.trim() }
        : { mode, repository: repository.trim(), visibility };
    setPending(true);
    setError(undefined);
    try {
      const result = await connectProjectGit(projectId, input);
      onConnected(result.status);
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  const initializes = status.repositoryState === "not-a-repository";
  const valid = choosesRemote
    ? Boolean(remoteUrl)
    : mode === "existing" ? Boolean(remoteUrl.trim()) : /^[^/\s]+\/[^/\s]+$/.test(repository.trim());
  const formTitle = choosesRemote ? "Choose a remote" : mode === "github" ? "Create on GitHub" : "Use an existing remote";
  const formDescription = choosesRemote
    ? `Choose which remote ${status.branch ?? projectName} should publish to.`
    : mode === "github"
      ? "Create a GitHub repository and connect this Forge workspace."
      : "Connect this Forge workspace to an existing remote repository.";

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        aria-describedby="connect-repository-description"
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle
            ref={view === "form" ? formTitleRef : undefined}
            tabIndex={view === "form" ? -1 : undefined}
          >{view === "chooser" ? "Connect a repository" : formTitle}</DialogTitle>
          <DialogDescription id="connect-repository-description">
            {view === "chooser" ? "Choose how this workspace should connect." : formDescription}
          </DialogDescription>
        </DialogHeader>

        {view === "chooser" ? (
          <div className="grid gap-4">
            <ConnectionTypeChooser
              mode={mode}
              selectedRef={chooserRef}
              onModeChange={(nextMode) => {
                setMode(nextMode);
                setError(undefined);
              }}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="button" onClick={() => setView("form")}>Continue</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={submit}>
            <FieldGroup>
              {choosesRemote ? (
                <RadioGroup
                  value={remoteUrl}
                  onValueChange={(value) => { setRemoteUrl(value); setError(undefined); }}
                  aria-label="Git remote"
                  disabled={pending}
                >
                  {(status.remotes ?? []).map((remote) => {
                    const id = `git-remote-${remote.name}`;
                    return (
                      <FieldLabel key={remote.name} htmlFor={id}>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <div id={`${id}-label`} className="font-mono font-medium">{remote.name}</div>
                            <FieldDescription id={`${id}-description`} className="truncate">
                              {remote.webUrl ?? remote.url ?? "Configured remote"}
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem
                            id={id}
                            value={remote.name}
                            aria-labelledby={`${id}-label`}
                            aria-describedby={`${id}-description`}
                          />
                        </Field>
                      </FieldLabel>
                    );
                  })}
                </RadioGroup>
              ) : mode === "existing" ? (
                <Field>
                  <FieldLabel htmlFor="git-remote-url">Remote URL</FieldLabel>
                  <Input
                    id="git-remote-url"
                    value={remoteUrl}
                    onChange={(event) => {
                      setRemoteUrl(event.target.value);
                      setError(undefined);
                    }}
                    placeholder="git@github.com:owner/repository.git"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    disabled={pending}
                    required
                  />
                  <FieldDescription>The remote will be added as <span className="font-mono">origin</span>.</FieldDescription>
                </Field>
              ) : (
                <>
                  <Field>
                    <FieldLabel htmlFor="github-repository">GitHub repository</FieldLabel>
                    <Input
                      id="github-repository"
                      value={repository}
                      onChange={(event) => {
                        setRepository(event.target.value);
                        setError(undefined);
                      }}
                      placeholder="owner/repository"
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                      disabled={pending}
                      required
                    />
                    <FieldDescription>Forge uses its authenticated GitHub CLI account.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel>Visibility</FieldLabel>
                    <RadioGroup
                      value={visibility}
                      onValueChange={(value) => setVisibility(value as "private" | "public")}
                      aria-label="GitHub repository visibility"
                      disabled={pending}
                    >
                      <FieldLabel htmlFor="github-visibility-private">
                        <Field orientation="horizontal">
                          <FieldContent><div className="font-medium">Private</div></FieldContent>
                          <RadioGroupItem id="github-visibility-private" value="private" />
                        </Field>
                      </FieldLabel>
                      <FieldLabel htmlFor="github-visibility-public">
                        <Field orientation="horizontal">
                          <FieldContent><div className="font-medium">Public</div></FieldContent>
                          <RadioGroupItem id="github-visibility-public" value="public" />
                        </Field>
                      </FieldLabel>
                    </RadioGroup>
                  </Field>
                </>
              )}
            </FieldGroup>

            {initializes && (
              <Alert>
                <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.8} aria-hidden="true" />
                <AlertDescription>
                  Git will be initialized on <span className="font-mono text-foreground">main</span>. Existing files will be kept.
                </AlertDescription>
              </Alert>
            )}
            {error && <FieldError>{error}</FieldError>}

            <DialogFooter>
              {!choosesRemote && <Button type="button" variant="outline" onClick={() => setView("chooser")} disabled={pending}>Back</Button>}
              {choosesRemote && <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>}
              <Button type="submit" disabled={!valid || pending}>
                {pending ? "Connecting…" : choosesRemote ? "Use selected remote" : mode === "github" ? "Create & connect" : "Connect repository"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
