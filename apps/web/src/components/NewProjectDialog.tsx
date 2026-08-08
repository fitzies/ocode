import { normalizeProjectSlug, type GitHubRepositoryPage, type GitHubRepositorySummary } from "@anvil/protocol";
import { LockIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, type Ref, useEffect, useRef, useState } from "react";

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
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { githubRepositoryName } from "@/lib/githubRepository";

function projectPath(root: string, slug: string): string {
  return `${root.replace(/\/$/, "")}/${slug}`;
}

export type NewProjectSource = "clone" | "empty" | "existing";

export const NEW_PROJECT_SOURCE_OPTIONS: ReadonlyArray<{
  value: NewProjectSource;
  title: string;
  description: string;
}> = [
  { value: "clone", title: "Clone a repository (GitHub)", description: "Clone a repository using Forge’s GitHub access" },
  { value: "empty", title: "Start empty", description: "Create a new directory on Forge" },
  { value: "existing", title: "Use a Forge directory", description: "Register a workspace already on disk" },
];

export function inferProjectNameFromRepository(input: string): string | undefined {
  return githubRepositoryName(input.trim());
}

export type GitHubRepositoryLoadStatus = "idle" | "loading" | "ready" | "error";
export type GitHubRepositoryLoadMoreStatus = "idle" | "loading" | "error";

export function repositorySelectPlaceholder(status: GitHubRepositoryLoadStatus): string {
  return status === "loading" ? "Loading repositories…" : "Choose a repository";
}

export function appendGitHubRepositories(
  current: readonly GitHubRepositorySummary[],
  incoming: readonly GitHubRepositorySummary[],
): GitHubRepositorySummary[] {
  const repositories = [...current];
  const seen = new Set(current.map((repository) => repository.nameWithOwner.toLowerCase()));
  for (const repository of incoming) {
    const key = repository.nameWithOwner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repositories.push(repository);
  }
  return repositories;
}

export function repositoryCatalogStatusText(
  initialStatus: GitHubRepositoryLoadStatus,
  loadMoreStatus: GitHubRepositoryLoadMoreStatus,
  count: number,
  hasMore: boolean,
): string {
  if (initialStatus === "loading") return "Loading repositories…";
  if (initialStatus === "error") return "Repository loading failed. Retry to try again.";
  if (initialStatus !== "ready") return "";
  if (loadMoreStatus === "loading") return `Loading more repositories. ${count} loaded.`;
  if (loadMoreStatus === "error") return `Could not load more repositories. ${count} ${count === 1 ? "repository remains" : "repositories remain"} loaded.`;
  if (count === 0 && !hasMore) return "No repositories are available.";
  return `${count} ${count === 1 ? "repository" : "repositories"} loaded. ${hasMore ? "More repositories are available." : "All available repositories loaded."}`;
}

export function applyRepositorySelection(
  repository: string,
  currentName: string,
  nameEdited: boolean,
): { repository: string; name: string } {
  return {
    repository,
    name: nameEdited ? currentName : inferProjectNameFromRepository(repository) ?? "",
  };
}

function RepositoryLabel({ repository }: { repository: GitHubRepositorySummary }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate" title={repository.nameWithOwner}>{repository.nameWithOwner}</span>
      {repository.private && (
        <>
          <span className="sr-only"> private repository</span>
          <span className="shrink-0 text-muted-foreground" title="Private repository" aria-hidden="true">
            <HugeiconsIcon icon={LockIcon} strokeWidth={1.8} className="size-3" aria-hidden="true" />
          </span>
        </>
      )}
    </span>
  );
}

export function GitHubRepositorySelect({
  repositories,
  status,
  value,
  onValueChange,
  disabled,
  triggerRef,
  describedBy,
  invalid,
}: {
  repositories: readonly GitHubRepositorySummary[];
  status: GitHubRepositoryLoadStatus;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  describedBy?: string;
  invalid?: boolean;
}) {
  const selected = repositories.find((repository) => repository.nameWithOwner === value);
  return (
    <Select value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        ref={triggerRef}
        id="clone-repository"
        className="w-full"
        aria-labelledby="clone-repository-label"
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-busy={status === "loading"}
      >
        <SelectValue placeholder={repositorySelectPlaceholder(status)}>
          {selected ? <RepositoryLabel repository={selected} /> : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectGroup>
          {repositories.map((repository) => (
            <SelectItem
              key={repository.nameWithOwner}
              value={repository.nameWithOwner}
              className="min-w-0 pr-8"
              textValue={repository.private ? `${repository.nameWithOwner} private repository` : repository.nameWithOwner}
            >
              <RepositoryLabel repository={repository} />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function RepositoryLoadMoreButton({
  hasMore,
  status,
  disabled,
  onLoadMore,
  describedBy,
}: {
  hasMore: boolean;
  status: GitHubRepositoryLoadMoreStatus;
  disabled?: boolean;
  onLoadMore: () => void;
  describedBy?: string;
}) {
  if (!hasMore) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onLoadMore}
      disabled={disabled || status === "loading"}
      aria-busy={status === "loading"}
      aria-describedby={describedBy}
    >
      {status === "loading"
        ? "Loading more repositories…"
        : status === "error" ? "Retry loading more repositories" : "Load more repositories"}
    </Button>
  );
}

export function NewProjectSourceChooser({
  source,
  onSourceChange,
  selectedRef,
}: {
  source: NewProjectSource;
  onSourceChange: (source: NewProjectSource) => void;
  selectedRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <FieldGroup>
      <RadioGroup
        value={source}
        onValueChange={(value) => onSourceChange(value as NewProjectSource)}
        aria-label="Project source"
      >
        {NEW_PROJECT_SOURCE_OPTIONS.map((option) => {
          const id = `project-source-${option.value}`;
          return (
            <FieldLabel key={option.value} htmlFor={id}>
              <Field orientation="horizontal">
                <FieldContent>
                  <div id={`${id}-label`} className="font-medium">{option.title}</div>
                  <FieldDescription id={`${id}-description`}>{option.description}</FieldDescription>
                </FieldContent>
                <RadioGroupItem
                  ref={option.value === source ? selectedRef : undefined}
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
      <FieldDescription>Operations run on Forge, not in this browser.</FieldDescription>
    </FieldGroup>
  );
}

export function NewProjectDialog({
  onClose,
  onCreate,
  onClone,
  onAddExisting,
  listGitHubRepositories,
  getProjectsRoot,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<{ status: "created" } | { status: "existing"; path: string }>;
  onClone: (name: string, repository: string) => Promise<void>;
  onAddExisting: (name: string, path: string) => Promise<void>;
  listGitHubRepositories: (page?: number) => Promise<GitHubRepositoryPage>;
  getProjectsRoot: () => Promise<string>;
}) {
  const [view, setView] = useState<"chooser" | "form">("chooser");
  const [source, setSource] = useState<NewProjectSource>("clone");
  const [repository, setRepository] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepositorySummary[]>([]);
  const [repositoryStatus, setRepositoryStatus] = useState<GitHubRepositoryLoadStatus>("idle");
  const [repositoryError, setRepositoryError] = useState<string>();
  const [repositoryPage, setRepositoryPage] = useState(0);
  const [hasMoreRepositories, setHasMoreRepositories] = useState(false);
  const [loadMoreStatus, setLoadMoreStatus] = useState<GitHubRepositoryLoadMoreStatus>("idle");
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const [cloneName, setCloneName] = useState("");
  const [cloneNameEdited, setCloneNameEdited] = useState(false);
  const [emptyName, setEmptyName] = useState("");
  const [existingName, setExistingName] = useState("");
  const [projectsRoot, setProjectsRoot] = useState<string>();
  const [rootError, setRootError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const chooserRef = useRef<HTMLButtonElement>(null);
  const formTitleRef = useRef<HTMLHeadingElement>(null);
  const repositoryRequestRef = useRef(0);
  const name = source === "clone" ? cloneName : source === "empty" ? emptyName : existingName;
  const slug = normalizeProjectSlug(name);
  const destination = projectsRoot
    ? projectPath(projectsRoot, slug || "project-name")
    : "Loading projects root…";
  const repositorySelected = repositoryStatus === "ready" &&
    repositories.some((candidate) => candidate.nameWithOwner === repository);
  const repositoryStatusText = repositoryCatalogStatusText(
    repositoryStatus,
    loadMoreStatus,
    repositories.length,
    hasMoreRepositories,
  );

  useEffect(() => () => {
    repositoryRequestRef.current++;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getProjectsRoot().then((path) => {
      if (!cancelled) setProjectsRoot(path);
    }).catch((failure) => {
      if (!cancelled) setRootError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { cancelled = true; };
  }, [getProjectsRoot]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (view === "chooser") chooserRef.current?.focus();
      else formTitleRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [view]);

  const loadRepositories = () => {
    const request = ++repositoryRequestRef.current;
    setRepositoryStatus("loading");
    setRepositoryError(undefined);
    setRepositoryPage(0);
    setHasMoreRepositories(false);
    setLoadMoreStatus("idle");
    setLoadMoreError(undefined);
    void listGitHubRepositories(1).then((result) => {
      if (request !== repositoryRequestRef.current) return;
      setRepositories(result.repositories);
      setRepositoryPage(result.page);
      setHasMoreRepositories(result.hasMore);
      setRepositoryStatus("ready");
    }).catch((failure) => {
      if (request !== repositoryRequestRef.current) return;
      setRepositories([]);
      setRepositoryStatus("error");
      setRepositoryError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  const loadMoreRepositories = () => {
    if (!hasMoreRepositories || loadMoreStatus === "loading" || repositoryStatus !== "ready") return;
    const request = ++repositoryRequestRef.current;
    setLoadMoreStatus("loading");
    setLoadMoreError(undefined);
    void listGitHubRepositories(repositoryPage + 1).then((result) => {
      if (request !== repositoryRequestRef.current) return;
      setRepositories((current) => appendGitHubRepositories(current, result.repositories));
      setRepositoryPage(result.page);
      setHasMoreRepositories(result.hasMore);
      setLoadMoreStatus("idle");
    }).catch((failure) => {
      if (request !== repositoryRequestRef.current) return;
      setLoadMoreStatus("error");
      setLoadMoreError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  const updateRepository = (value: string) => {
    const selection = applyRepositorySelection(value, cloneName, cloneNameEdited);
    setRepository(selection.repository);
    setCloneName(selection.name);
    setError(undefined);
  };

  const back = () => {
    if (pending) return;
    setError(undefined);
    setView("chooser");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !slug || !projectsRoot || pending || (source === "clone" && !repositorySelected)) return;
    setPending(true);
    setError(undefined);
    try {
      if (source === "clone") {
        await onClone(name.trim(), repository);
      } else if (source === "existing") {
        await onAddExisting(name.trim(), destination);
      } else {
        const result = await onCreate(name.trim());
        if (result.status === "existing") {
          setError(`A directory already exists at ${result.path}. Go back and choose “Use a Forge directory” to register it.`);
          setPending(false);
          return;
        }
      }
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  const formTitle = source === "clone" ? "Clone a repository" : source === "empty" ? "Start empty" : "Use a Forge directory";
  const formDescription = source === "clone"
    ? "Clone a GitHub repository into a new Forge workspace."
    : source === "empty"
      ? "Create a new, empty workspace under the configured projects root."
      : "Verify and register an existing directory directly under the projects root.";

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        aria-describedby="add-project-description"
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle
            ref={view === "form" ? formTitleRef : undefined}
            tabIndex={view === "form" ? -1 : undefined}
          >{view === "chooser" ? "Add a project" : formTitle}</DialogTitle>
          <DialogDescription id="add-project-description">
            {view === "chooser" ? "Choose where the workspace should come from." : formDescription}
          </DialogDescription>
        </DialogHeader>

        {view === "chooser" ? (
          <div className="grid gap-4">
            <NewProjectSourceChooser
              source={source}
              selectedRef={chooserRef}
              onSourceChange={(value) => {
                setSource(value);
                setError(undefined);
              }}
            />
            {rootError && <FieldError role="alert">{rootError}</FieldError>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                type="button"
                onClick={() => {
                  setView("form");
                  if (source === "clone") loadRepositories();
                }}
                disabled={!projectsRoot}
              >Continue</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={submit}
            aria-describedby={(rootError || error) ? "project-operation-error" : undefined}
          >
            <FieldGroup>
              {source === "clone" && (
                <Field data-invalid={repositoryStatus === "error" || undefined}>
                  <FieldLabel id="clone-repository-label" htmlFor="clone-repository">Repository</FieldLabel>
                  <GitHubRepositorySelect
                    repositories={repositories}
                    status={repositoryStatus}
                    value={repository}
                    onValueChange={updateRepository}
                    disabled={pending || repositoryStatus !== "ready" || repositories.length === 0}
                    describedBy={`clone-repository-description clone-repository-status${repositoryError ? " clone-repository-error" : ""}${loadMoreError ? " clone-repository-load-more-error" : ""}`}
                    invalid={Boolean(repositoryError)}
                  />
                  <FieldDescription id="clone-repository-description">
                    {repositoryStatus === "ready" && repositories.length === 0 && !hasMoreRepositories
                      ? "No repositories are available to Forge’s authenticated GitHub account."
                      : "Repositories available to Forge’s authenticated GitHub CLI account."}
                  </FieldDescription>
                  <p
                    id="clone-repository-status"
                    className="text-xs text-muted-foreground"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >{repositoryStatusText}</p>
                  {repositoryError && <FieldError id="clone-repository-error">{repositoryError}</FieldError>}
                  {loadMoreError && <FieldError id="clone-repository-load-more-error">{loadMoreError}</FieldError>}
                  {repositoryStatus === "error" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-fit"
                      onClick={loadRepositories}
                      disabled={pending}
                    >Retry</Button>
                  )}
                  {repositoryStatus === "ready" && (
                    <RepositoryLoadMoreButton
                      hasMore={hasMoreRepositories}
                      status={loadMoreStatus}
                      disabled={pending}
                      onLoadMore={loadMoreRepositories}
                      describedBy="clone-repository-status"
                    />
                  )}
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor={`${source}-project-name`}>Project name</FieldLabel>
                <Input
                  id={`${source}-project-name`}
                  value={name}
                  onChange={(event) => {
                    if (source === "clone") {
                      setCloneName(event.target.value);
                      setCloneNameEdited(true);
                    } else if (source === "empty") setEmptyName(event.target.value);
                    else setExistingName(event.target.value);
                    setError(undefined);
                  }}
                  placeholder="My project"
                  maxLength={80}
                  disabled={pending}
                  aria-invalid={(Boolean(name.trim()) && !slug) || undefined}
                  required
                />
                {name.trim() && !slug && <FieldDescription>Use a name containing letters or numbers.</FieldDescription>}
              </Field>
              <Field>
                <FieldLabel htmlFor={`${source}-project-destination`}>Directory on Forge</FieldLabel>
                <Input
                  id={`${source}-project-destination`}
                  value={destination}
                  readOnly
                  spellCheck={false}
                  aria-label="Project destination preview"
                  className="font-mono text-xs text-muted-foreground"
                />
                {source === "clone" && <FieldDescription>Forge uses its GitHub CLI authentication, including access to private repositories.</FieldDescription>}
                {source === "empty" && <FieldDescription>This mode only creates a new directory; it never registers an existing one.</FieldDescription>}
                {source === "existing" && <FieldDescription>The directory must already exist. Forge will register it without creating or changing files.</FieldDescription>}
              </Field>
            </FieldGroup>
            {(rootError || error) && <FieldError id="project-operation-error" role="alert">{rootError ?? error}</FieldError>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={back} disabled={pending}>Back</Button>
              <Button
                type="submit"
                disabled={!name.trim() || !slug || !projectsRoot || pending || (source === "clone" && !repositorySelected)}
              >
                {pending
                  ? source === "clone" ? "Cloning…" : source === "empty" ? "Creating…" : "Adding…"
                  : source === "clone" ? "Clone project" : source === "empty" ? "Create project" : "Add existing project"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

