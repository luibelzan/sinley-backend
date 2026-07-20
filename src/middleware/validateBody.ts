import { RequestHandler } from "express";
import { ZodSchema } from "zod";
import { AppError } from "../utils/AppError";

export function validateBody(schema: ZodSchema): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      next(new AppError(400, "validation_error", firstIssue?.message ?? "Datos de entrada inválidos"));
      return;
    }
    req.body = result.data;
    next();
  };
}
