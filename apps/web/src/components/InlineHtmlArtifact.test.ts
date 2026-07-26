import { describe, expect, it } from "vitest";

import { buildInlineHtmlDocument } from "./InlineHtmlArtifact";

describe("inline HTML document wrapper", () => {
  it("places the renderer policy and bridge before generated content", () => {
    const source = buildInlineHtmlDocument(
      "<!doctype html><html><head><script>window.generated = true</script></head><body>Preview</body></html>",
      "render-token",
    );

    expect(source).toContain("Content-Security-Policy");
    expect(source).toContain("connect-src 'none'");
    expect(source).toContain("script-src 'nonce-render-token'");
    expect(source).toContain('<script nonce="render-token">');
    expect(source).toContain("parent.postMessage");
    expect(source.indexOf("Content-Security-Policy")).toBeLessThan(source.indexOf("const encodedMarkup"));
    expect(source).not.toContain("window.generated");
    expect(source).toContain("new DOMParser()");
    expect(source).toContain('const token = "render-token"');
  });

  it("wraps HTML fragments in a complete transparent document", () => {
    const source = buildInlineHtmlDocument("<svg aria-label=\"Smiley\"></svg>", "token");

    expect(source).toMatch(/^<!doctype html><html><head>/);
    expect(source).toContain("background: transparent !important");
    expect(source).not.toContain('<svg aria-label="Smiley">');
    expect(source).toContain("document.body.append(fragment)");
    expect(source).toContain("if (document.body) install()");
    expect(source).toContain('document.addEventListener("DOMContentLoaded", install, { once: true })');
    expect(source.indexOf("if (document.body) install()")).toBeLessThan(source.indexOf("<body></body></html>"));
    expect(source).toContain("<body></body></html>");
  });

  it("keeps the trusted policy ahead of misleading generated head markup", () => {
    const generated = '<!-- <head> --><script>fetch("https://example.com")</script><p>Preview</p>';
    const source = buildInlineHtmlDocument(generated, "safe-token");

    expect(source).not.toContain("<!-- <head> -->");
    expect(source).not.toContain("https://example.com");
    expect(source).toContain("script-src 'nonce-safe-token'");
    expect(source).toContain('querySelectorAll("script, iframe, frame, object, embed, base, meta[http-equiv]")');
    expect(source).not.toContain("script-src 'unsafe-inline'");
  });
});
