import { z } from "zod";

export const registerSchema = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_]{3,20}$/, "El usuario debe tener 3-20 caracteres: letras, números o guión bajo"),
  email: z.string().email("El email no tiene un formato válido"),
  password: z
    .string()
    .min(8, "La contraseña debe tener al menos 8 caracteres")
    .max(72, "La contraseña es demasiado larga"), // bcrypt ignora a partir de 72 bytes
});

export const loginSchema = z.object({
  email: z.string().email("El email no tiene un formato válido"),
  password: z.string().min(1, "La contraseña es obligatoria"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken es obligatorio"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
