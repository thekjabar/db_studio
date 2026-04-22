import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 configuration.
 *
 * In Prisma 7 the datasource URL is no longer declared inside `schema.prisma`;
 * it lives here (or is resolved from the DATABASE_URL env var by this config).
 *
 * `schema` points at the `prisma/` folder so Prisma recursively picks up every
 * `*.prisma` file inside it (main schema + ./models + ./enums). The main file
 * containing the `datasource` block must sit at the root of that folder, and
 * the `migrations/` directory must be a sibling of it.
 */
export default defineConfig({
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "ts-node --transpile-only prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
