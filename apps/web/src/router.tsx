import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { AppShell } from "./components/AppShell";

function EmptyRoute() {
  return null;
}

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: EmptyRoute,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: EmptyRoute,
});
const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  component: EmptyRoute,
});
const piCatalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pi",
  component: EmptyRoute,
});
const piSkillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pi/skills",
  component: EmptyRoute,
});
const piSkillDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pi/skills/$resourceId",
  component: EmptyRoute,
});
const piExtensionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pi/extensions",
  component: EmptyRoute,
});
const piExtensionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pi/extensions/$resourceId",
  component: EmptyRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute,
  usageRoute,
  piCatalogRoute,
  piSkillsRoute,
  piSkillDetailRoute,
  piExtensionsRoute,
  piExtensionDetailRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
