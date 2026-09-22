/** Preserve unknown frontmatter verbatim while editing the supported scalar fields. */
export function agentDocument(source: string): { header: string; text: string; fields: Record<string, string> } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  const header = match?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const field = /^([a-zA-Z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2]!.trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { /* Preserve unfamiliar scalars. */ }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    fields[field[1]!] = value;
  }
  return { header, fields, text: match ? source.slice(match[0].length) : source };
}

export function updateAgentDocument(source: string, fields: Record<string, string>, text: string): string {
  let { header } = agentDocument(source);
  for (const [key, value] of Object.entries(fields)) {
    // Replace a complete field, including any indented YAML continuation lines.
    const pattern = new RegExp(`^${key}:[^\\n]*(?:\\n(?:[ \\t]+[^\\n]*|[ \\t]*$))*`, "gm");
    const line = `${key}: ${JSON.stringify(value)}`;
    if (pattern.test(header)) header = header.replace(pattern, () => line);
    else header += `${header ? "\n" : ""}${line}`;
  }
  return `---\n${header}\n---\n${text}`;
}
