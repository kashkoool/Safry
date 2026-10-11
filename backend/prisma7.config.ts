import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts"
  },
  datasource: {
    // Migrations need an owner role; the running app may use a restricted one (DATABASE_URL).
    url: process.env["DATABASE_MIGRATE_URL"] ?? process.env["DATABASE_URL"]
  }
});
