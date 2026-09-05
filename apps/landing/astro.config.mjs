import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// Local dev: everything the Worker owns is forwarded to `wrangler dev`
// (bun run dev, :8787) so the landing's relative fetches and links work
// under Astro's HMR server. Astro keeps its own pages (/, /connect, /profile, /setup)
// and assets; the Worker handles the API, checkout, invites, and skill.md.
const worker = "http://localhost:8787";
const workerPaths = ["/api", "/buy", "/i/", "/g/", "/r/", "/skill.md", "/owner", "/recover", "/mcp"];

export default defineConfig({
  site: "https://hi.new",
  integrations: [react()],
  vite: {
    server: {
      proxy: Object.fromEntries(workerPaths.map((p) => [p, worker])),
    },
  },
});
