import { ErrorRequestHandler } from "express";
import { AppError } from "../utils/AppError";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // No filtramos errores inesperados al cliente: solo un mensaje genérico.
  console.error("Error no controlado:", err);
  res.status(500).json({ error: { code: "internal_error", message: "Error interno del servidor" } });
};
