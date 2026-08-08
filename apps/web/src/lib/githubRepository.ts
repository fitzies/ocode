const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.](?:[A-Za-z0-9_.-]{0,98})?$/;

function validParts(owner: string, repository: string): boolean {
  const name = repository.replace(/\.git$/i, "");
  return OWNER_PATTERN.test(owner)
    && REPOSITORY_PATTERN.test(name)
    && name !== "."
    && name !== ".."
    && !name.startsWith("-");
}

/** Browser-side format check aligned with Forge's project.clone repository forms. */
export function isValidGitHubRepository(input: string): boolean {
  if (
    !input
    || input !== input.trim()
    || input.length > 2_048
    || /[\u0000-\u001f\u007f]/.test(input)
    || /[?#]/.test(input)
  ) return false;

  const shorthand = /^([^/:\s]+)\/([^/\s]+)$/.exec(input);
  if (shorthand) return validParts(shorthand[1]!, shorthand[2]!);

  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(input);
  if (scp) return validParts(scp[1]!, scp[2]!);

  try {
    const url = new URL(input);
    if (
      !["https:", "ssh:"].includes(url.protocol)
      || url.hostname.toLowerCase() !== "github.com"
      || Boolean(url.port)
      || Boolean(url.password)
      || Boolean(url.search)
      || Boolean(url.hash)
      || (url.protocol === "https:" ? Boolean(url.username) : url.username !== "git")
    ) return false;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2
      && url.pathname === `/${parts[0]}/${parts[1]}`
      && validParts(parts[0]!, parts[1]!);
  } catch {
    return false;
  }
}

export function githubRepositoryName(input: string): string | undefined {
  if (!isValidGitHubRepository(input)) return undefined;
  const shorthand = /^[^/:\s]+\/([^/\s]+)$/.exec(input);
  const scp = /^git@github\.com:[^/\s]+\/([^/\s]+)$/i.exec(input);
  if (shorthand || scp) return (shorthand?.[1] ?? scp?.[1])!.replace(/\.git$/i, "");
  const parts = new URL(input).pathname.split("/").filter(Boolean);
  return parts[1]!.replace(/\.git$/i, "");
}
