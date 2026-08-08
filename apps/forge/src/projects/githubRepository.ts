export class GitHubRepositoryValidationError extends Error {
  constructor(message = "Enter a valid GitHub repository using owner/repository or a GitHub HTTPS or SSH URL") {
    super(message);
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.](?:[A-Za-z0-9_.-]{0,98})?$/;

function validateParts(owner: string, repository: string): string {
  const cleanRepository = repository.replace(/\.git$/i, "");
  if (
    !OWNER_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(cleanRepository) ||
    cleanRepository === "." ||
    cleanRepository === ".." ||
    cleanRepository.startsWith("-")
  ) {
    throw new GitHubRepositoryValidationError();
  }
  return `${owner}/${cleanRepository}`;
}

/** Normalize the GitHub repository forms accepted by project.clone to owner/repository. */
export function normalizeGitHubRepository(input: string): string {
  if (
    !input ||
    input !== input.trim() ||
    input.length > 2_048 ||
    /[\u0000-\u001f\u007f]/.test(input) ||
    /[?#]/.test(input)
  ) {
    throw new GitHubRepositoryValidationError();
  }

  const shorthand = /^([^/:\s]+)\/([^/\s]+)$/.exec(input);
  if (shorthand) return validateParts(shorthand[1]!, shorthand[2]!);

  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(input);
  if (scp) return validateParts(scp[1]!, scp[2]!);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new GitHubRepositoryValidationError();
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "https:" ? Boolean(url.username) : url.username !== "git")
  ) {
    throw new GitHubRepositoryValidationError();
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || url.pathname !== `/${parts[0]}/${parts[1]}`) {
    throw new GitHubRepositoryValidationError();
  }
  return validateParts(parts[0]!, parts[1]!);
}
