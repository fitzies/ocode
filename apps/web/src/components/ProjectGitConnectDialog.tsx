import type { ProjectGitConnectRequest, ProjectGitStatus } from "@anvil/protocol";
import { GithubIcon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { connectProjectGit } from "@/lib/projectGit";

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
  const [mode, setMode] = useState<"existing" | "github" | "select">("existing");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [repository, setRepository] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const firstInputRef = useRef<HTMLInputElement>(null);

  const choosesRemote = status.repositoryState === "ambiguous-remote";

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setMode(choosesRemote ? "select" : "existing");
    if (choosesRemote) setRemoteUrl(status.remotes?.[0]?.name ?? "");
  }, [choosesRemote, open, projectId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const input: ProjectGitConnectRequest = mode === "existing"
      ? { mode, remoteUrl: remoteUrl.trim() }
      : mode === "select"
        ? { mode, remoteName: remoteUrl }
        : { mode, repository: repository.trim(), visibility };
    setPending(true);
    setError(undefined);
    try {
      const result = await connectProjectGit(projectId, input);
      onConnected(result.status);
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };

  const initializes = status.repositoryState === "not-a-repository";
  const valid = mode === "select"
    ? Boolean(remoteUrl)
    : mode === "existing" ? Boolean(remoteUrl.trim()) : /^[^/\s]+\/[^/\s]+$/.test(repository.trim());

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-md"
        aria-describedby="connect-repository-description"
        onOpenAutoFocus={(event) => {
          if (choosesRemote) return;
          event.preventDefault();
          firstInputRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Forge repository
          </span>
          <DialogTitle>Connect repository</DialogTitle>
          <DialogDescription id="connect-repository-description">
            {choosesRemote
              ? `Choose which remote ${status.branch ?? projectName} should publish to.`
              : initializes
                ? "Initialize this workspace and connect it to a remote repository."
                : `Connect ${status.branch ?? projectName} to a remote repository.`}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit}>
          {choosesRemote ? (
            <RadioGroup
              value={remoteUrl}
              onValueChange={(value) => { setRemoteUrl(value); setError(undefined); }}
              aria-label="Git remote"
              disabled={pending}
            >
              {(status.remotes ?? []).map((remote) => (
                <FieldLabel key={remote.name} className="cursor-pointer rounded-lg border border-border p-3 has-data-checked:border-foreground/35 has-data-checked:bg-muted/40">
                  <Field orientation="horizontal">
                    <RadioGroupItem value={remote.name} />
                    <div className="min-w-0">
                      <span className="block font-mono">{remote.name}</span>
                      <span className="block truncate text-[0.625rem] text-muted-foreground">{remote.webUrl ?? remote.url ?? "Configured remote"}</span>
                    </div>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          ) : (
          <RadioGroup
            value={mode}
            onValueChange={(value) => {
              setMode(value as "existing" | "github");
              setError(undefined);
              window.setTimeout(() => firstInputRef.current?.focus(), 0);
            }}
            aria-label="Repository connection type"
            className="grid grid-cols-2 gap-2"
            disabled={pending}
          >
            <FieldLabel className="cursor-pointer rounded-lg border border-border p-3 has-data-checked:border-foreground/35 has-data-checked:bg-muted/40">
              <Field orientation="horizontal">
                <RadioGroupItem value="existing" />
                <div className="flex min-w-0 items-center gap-2">
                  <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} className="size-4 text-muted-foreground" />
                  <span>Existing remote</span>
                </div>
              </Field>
            </FieldLabel>
            <FieldLabel className="cursor-pointer rounded-lg border border-border p-3 has-data-checked:border-foreground/35 has-data-checked:bg-muted/40">
              <Field orientation="horizontal">
                <RadioGroupItem value="github" />
                <div className="flex min-w-0 items-center gap-2">
                  <HugeiconsIcon icon={GithubIcon} strokeWidth={1.8} className="size-4 text-muted-foreground" />
                  <span>New on GitHub</span>
                </div>
              </Field>
            </FieldLabel>
          </RadioGroup>
          )}

          {!choosesRemote && <FieldGroup>
            {mode === "existing" ? (
              <Field>
                <FieldLabel htmlFor="git-remote-url">Remote URL</FieldLabel>
                <Input
                  ref={firstInputRef}
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
                    ref={firstInputRef}
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
                  <FieldDescription>Forge uses its existing GitHub CLI authentication.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Visibility</FieldLabel>
                  <RadioGroup
                    value={visibility}
                    onValueChange={(value) => setVisibility(value as "private" | "public")}
                    aria-label="GitHub repository visibility"
                    className="flex gap-4"
                    disabled={pending}
                  >
                    <FieldLabel className="cursor-pointer"><Field orientation="horizontal"><RadioGroupItem value="private" />Private</Field></FieldLabel>
                    <FieldLabel className="cursor-pointer"><Field orientation="horizontal"><RadioGroupItem value="public" />Public</Field></FieldLabel>
                  </RadioGroup>
                </Field>
              </>
            )}
          </FieldGroup>}

          {initializes && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
              Git will be initialized on <span className="font-mono text-foreground">main</span>. Existing project files will be kept; a <span className="font-mono text-foreground">.git</span> directory will be added.
            </div>
          )}
          {error && <FieldError>{error}</FieldError>}

          <DialogFooter className="border-t border-border/60 pt-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? "Connecting…" : mode === "select" ? "Use selected remote" : mode === "github" ? "Create & connect" : "Connect repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
