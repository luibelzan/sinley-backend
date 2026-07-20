import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatorio"),
  REDIS_URL: z.string().min(1, "REDIS_URL es obligatorio"),
  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET debe ser largo y aleatorio"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET debe ser largo y aleatorio"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),
  BCRYPT_SALT_ROUNDS: z.coerce.number().default(12),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Variables de entorno inválidas:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
