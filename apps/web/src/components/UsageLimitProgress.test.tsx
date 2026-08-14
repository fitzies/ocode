import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageLimitProgress } from "./UsageLimitProgress";

function render(usage?: Parameters<typeof UsageLimitProgress>[0]["usage"]) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UsageLimitProgress usage={usage} />
    </TooltipProvider>,
  );
}

describe("UsageLimitProgress", () => {
  it("renders the weekly window when the five-hour window is unavailable", () => {
    const markup = render({ weekly: { usedPercent: 32 } });

    expect(markup).toContain("Weekly");
    expect(markup).toContain("32%");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain('class="flex items-center gap-0.5"');
    expect(markup).not.toContain('data-slot="progress"');
    expect(markup).not.toContain("hidden sm:flex");
    expect(markup).not.toContain("5 hours");
  });

  it("renders nothing when no usage windows are available", () => {
    expect(render()).toBe("");
  });

  it("renders five-hour and weekly progress when available", () => {
    const markup = render({
      fiveHour: { usedPercent: 18 },
      weekly: { usedPercent: 41 },
    });

    expect(markup).toContain("5 hours");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("18%");
    expect(markup).toContain("41%");
  });
});
