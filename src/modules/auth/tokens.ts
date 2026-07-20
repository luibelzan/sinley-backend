import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import { env } from "../../config/env";
import { parseDurationToMs } from "../../utils/duration";

export interface AccessTokenPayload {
  sub: string; // id de usuario
  username: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

/**
 * El refresh token es una cadena opaca aleatoria (no un JWT): así, si se filtra
 * la base de datos, solo se filtran hashes, no algo que se pueda decodificar.
 * Se guarda en la BD como sha256(token), nunca en texto plano.
 */
export function generateRefreshToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(48).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + parseDurationToMs(env.JWT_REFRESH_EXPIRES_IN));
  return { token, tokenHash, expiresAt };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
