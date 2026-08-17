import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Children, Fragment, isValidElement, type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return Children.toArray(node).map(nodeText).join("");
}

function codeLanguage(children: ReactNode): string | undefined {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string }>(child)) return undefined;
  return /(?:^|\s)language-([^\s]+)/.exec(child.props.className ?? "")?.[1];
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  css: "CSS",
  html: "HTML",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  python: "Python",
  py: "Python",
  rust: "Rust",
  shell: "Shell",
  sh: "Shell",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  yaml: "YAML",
  yml: "YAML",
};

export function CodeBlock({ children }: { children?: ReactNode }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  const language = codeLanguage(children);
  const code = nodeText(children).replace(/\n$/, "");
  const lines = code.split("\n");
  const languageLabel = language ? LANGUAGE_LABELS[language.toLowerCase()] ?? language : "Code";

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopyState("idle"), 1_500);
  };

  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy";

  return (
    <div className="markdown-code-block" data-language={language}>
      <div className="markdown-code-header">
        <span>{languageLabel}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="markdown-code-copy"
          onClick={() => void copy()}
          aria-label={copyState === "idle" ? "Copy code" : copyLabel}
        >
          <HugeiconsIcon icon={copyState === "copied" ? Tick02Icon : Copy01Icon} strokeWidth={2} />
          <span aria-live="polite">{copyLabel}</span>
        </Button>
      </div>
      <pre aria-label={`${languageLabel} code`} tabIndex={0}>
        <code className={language ? `language-${language}` : undefined}>
          {lines.map((line, index) => (
            <Fragment key={index}>
              <span className="markdown-code-line">{line}</span>
              {index < lines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}
