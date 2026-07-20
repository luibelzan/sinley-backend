import { z } from "zod";

export const rechargeSchema = z.object({
  // Cantidad en unidades (p. ej. euros), no en céntimos: la conversión la hace el servidor.
  amount: z
    .number()
    .positive("La cantidad debe ser mayor que 0")
    .max(10_000, "La cantidad máxima por recarga es 10.000")
    .refine((v) => Number.isInteger(Math.round(v * 100)), {
      message: "La cantidad no puede tener más de 2 decimales",
    }),
});

export type RechargeInput = z.infer<typeof rechargeSchema>;
