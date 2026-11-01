import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Dieselbe .env wie das Backend, damit der Proxy weiß, ob die API HTTPS spricht
  const env = { ...loadEnv(mode, "../..", ""), ...process.env };
  const apiTarget = env.API_URL ?? `${env.HTTPS === "true" ? "https" : "http"}://localhost:${env.PORT ?? 3000}`;
  // Das selbst signierte Entwicklungszertifikat ist nicht vertrauenswürdig
  const proxy = { target: apiTarget, secure: false };

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { "/api": proxy, "/auth": proxy },
    },
  };
});
