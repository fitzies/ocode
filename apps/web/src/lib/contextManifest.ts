import {
  OCODE_CONTEXT_WIDGET_KEY,
  parseContextManifestWidgetLines,
  type ContextManifestV1,
  type ExtensionWidget,
} from "@anvil/protocol";

export function consumeContextManifestWidget(widgets: ExtensionWidget[]): {
  manifest: ContextManifestV1 | undefined;
  composerWidgets: ExtensionWidget[];
} {
  let manifest: ContextManifestV1 | undefined;
  const composerWidgets: ExtensionWidget[] = [];
  for (const widget of widgets) {
    if (widget.key !== OCODE_CONTEXT_WIDGET_KEY) {
      composerWidgets.push(widget);
      continue;
    }
    const parsed = parseContextManifestWidgetLines(widget.lines);
    if (parsed && (!manifest || parsed.capturedAt >= manifest.capturedAt)) manifest = parsed;
  }
  return { manifest, composerWidgets };
}
