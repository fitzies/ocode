import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": environment.ANVIL_DEV_FORGE_URL ?? "http://127.0.0.1:3210",
      },
    },
  };
});
