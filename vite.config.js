import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Images live in public/images but are served by the Express server via
// /img/:id (so URLs don't reveal original vs AI), so Vite doesn't copy public/.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:3001",
      "/img": "http://localhost:3001",
    },
  },
});
