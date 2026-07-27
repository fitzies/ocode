import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  external: ["node-pty"],
  noExternal: [/^@anvil\//],
  outDir: "dist",
  sourcemap: true,
  clean: true,
});
