import { normalizeProjectSlug, type GitHubRepositoryPage, type GitHubRepositorySummary, type ProjectDirectoryCatalog } from "@anvil/protocol";
import { FolderAddIcon, FolderOpenIcon, GithubIcon, LockIcon } from "@hugeicons/core-free-icons";
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
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
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
  { value: "empty", title: "New empty project", description: "Create a new directory on Forge" },
  { value: "clone", title: "From a GitHub repository", description: "Clone a repository using Forge’s GitHub access" },
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

export function NewProjectDialog({
  onClose,
  onCreate,
  onClone,
  onAddExisting,
  listGitHubRepositories,
  listProjectDirectories,
  getProjectsRoot,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<{ status: "created" } | { status: "existing"; path: string }>;
  onClone: (name: string, repository: string) => Promise<void>;
  onAddExisting: (name: string, path: string) => Promise<void>;
  listGitHubRepositories: (page?: number, query?: string) => Promise<GitHubRepositoryPage>;
  listProjectDirectories: () => Promise<ProjectDirectoryCatalog>;
  getProjectsRoot: () => Promise<string>;
}) {
  const [view, setView] = useState<"chooser" | "form">("chooser");
  const [source, setSource] = useState<NewProjectSource>("clone");
  const [repository, setRepository] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
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
  const [existingPath, setExistingPath] = useState("");
  const [projectDirectories, setProjectDirectories] = useState<ProjectDirectoryCatalog["directories"]>([]);
  const [directoryError, setDirectoryError] = useState<string>();
  const [projectsRoot, setProjectsRoot] = useState<string>();
  const [rootError, setRootError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const formTitleRef = useRef<HTMLHeadingElement>(null);
  const repositoryRequestRef = useRef(0);
  const name = source === "clone" ? cloneName : source === "empty" ? emptyName : existingName;
  const slug = normalizeProjectSlug(name);
  const destination = source === "existing" && existingPath
    ? existingPath
    : projectsRoot
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
    if (view !== "form") return;
    const timer = window.setTimeout(() => formTitleRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    void listProjectDirectories().then((catalog) => {
      setProjectDirectories(catalog.directories);
      setDirectoryError(undefined);
    }).catch((failure) => {
      setDirectoryError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [listProjectDirectories]);

  useEffect(() => {
    if (view !== "chooser") return;
    repositoryRequestRef.current++;
    setRepositoryStatus("loading");
    setRepositories([]);
    setHasMoreRepositories(false);
    const timer = window.setTimeout(() => loadRepositories(repositoryQuery), 300);
    return () => window.clearTimeout(timer);
  }, [repositoryQuery, view]);

  const loadRepositories = (query = repositoryQuery) => {
    const request = ++repositoryRequestRef.current;
    setRepositoryStatus("loading");
    setRepositoryError(undefined);
    setRepositoryPage(0);
    setHasMoreRepositories(false);
    setLoadMoreStatus("idle");
    setLoadMoreError(undefined);
    void listGitHubRepositories(1, query).then((result) => {
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
    void listGitHubRepositories(repositoryPage + 1, repositoryQuery).then((result) => {
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

  if (view === "chooser") {
    return (
      <CommandDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title="Add a project"
        description="Create a project or add a workspace from GitHub or Forge"
        className="sm:max-w-lg"
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            value={repositoryQuery}
            onValueChange={setRepositoryQuery}
            placeholder="Search GitHub repositories…"
            aria-label="Search GitHub repositories"
          />
          <CommandList className="max-h-[min(24rem,65vh)]">
            <CommandEmpty>No projects found.</CommandEmpty>
            {!repositoryQuery && <CommandGroup heading="Create">
              <CommandItem
                value="New empty project blank workspace"
                onSelect={() => {
                  setSource("empty");
                  setView("form");
                }}
              >
                <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} className="text-muted-foreground" />
                <span>New empty project</span>
                <CommandShortcut>Forge</CommandShortcut>
              </CommandItem>
            </CommandGroup>}
            {!repositoryQuery && <CommandSeparator />}
            <CommandGroup heading={repositoryQuery ? "GitHub results" : "GitHub repositories"}>
              {repositoryStatus === "loading" && (
                <CommandItem disabled>
                  <Spinner className="text-muted-foreground" />
                  Searching repositories…
                </CommandItem>
              )}
              {repositoryStatus === "error" && <CommandItem disabled>{repositoryError ?? "GitHub repositories unavailable"}</CommandItem>}
              {repositories.map((candidate) => (
                <CommandItem
                  key={candidate.nameWithOwner}
                  value={`${candidate.nameWithOwner} github repository`}
                  onSelect={() => {
                    const selection = applyRepositorySelection(candidate.nameWithOwner, cloneName, false);
                    setRepository(selection.repository);
                    setCloneName(selection.name);
                    setCloneNameEdited(false);
                    setSource("clone");
                    setView("form");
                  }}
                >
                  <HugeiconsIcon icon={GithubIcon} strokeWidth={2} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{candidate.nameWithOwner}</span>
                  {candidate.private && <CommandShortcut>Private</CommandShortcut>}
                </CommandItem>
              ))}
              {repositoryStatus === "ready" && repositories.length === 0 && <CommandItem disabled>No repositories available</CommandItem>}
            </CommandGroup>
            {!repositoryQuery && <CommandSeparator />}
            {!repositoryQuery && <CommandGroup heading="Forge directories">
              {projectDirectories.map((directory) => (
                <CommandItem
                  key={directory.path}
                  value={`${directory.name} ${directory.path} forge directory`}
                  onSelect={() => {
                    setExistingName(directory.name);
                    setExistingPath(directory.path);
                    setSource("existing");
                    setView("form");
                  }}
                >
                  <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{directory.name}</span>
                  <CommandShortcut>{directory.path}</CommandShortcut>
                </CommandItem>
              ))}
              {directoryError && <CommandItem disabled>Directory discovery unavailable</CommandItem>}
              {!directoryError && projectDirectories.length === 0 && <CommandItem disabled>No unregistered directories</CommandItem>}
            </CommandGroup>}
          </CommandList>
        </Command>
      </CommandDialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        aria-describedby="add-project-description"
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle ref={formTitleRef} tabIndex={-1}>{formTitle}</DialogTitle>
          <DialogDescription id="add-project-description">{formDescription}</DialogDescription>
        </DialogHeader>
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
                      onClick={() => loadRepositories()}
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
      </DialogContent>
    </Dialog>
  );
}

