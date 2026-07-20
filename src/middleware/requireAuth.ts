import { RequestHandler } from "express";
import { AppError } from "../utils/AppError";
import { verifyAccessToken } from "../modules/auth/tokens";

export const requireAuth: RequestHandler = (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    next(new AppError(401, "missing_token", "Falta el token de autenticación"));
    return;
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new AppError(401, "invalid_token", "El token de autenticación no es válido o ha caducado"));
  }
};
