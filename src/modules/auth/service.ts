import bcrypt from "bcrypt";
import { pool } from "../../db/pool";
import { env } from "../../config/env";
import { AppError } from "../../utils/AppError";
import {
  createUser,
  findRefreshTokenByHash,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  revokeRefreshToken,
  storeRefreshToken,
} from "./repository";
import { createWalletForUser } from "../wallet/repository";
import { generateRefreshToken, hashToken, signAccessToken } from "./tokens";
import { LoginInput, RegisterInput } from "./schemas";

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface PublicUser {
  id: string;
  username: string;
  email: string;
}

function toPublicUser(user: { id: string; username: string; email: string }): PublicUser {
  return { id: user.id, username: user.username, email: user.email };
}

async function issueTokens(user: { id: string; username: string }): Promise<AuthTokens> {
  const accessToken = signAccessToken({ sub: user.id, username: user.username });
  const { token: refreshToken, tokenHash, expiresAt } = generateRefreshToken();
  await storeRefreshToken({ userId: user.id, tokenHash, expiresAt });
  return { accessToken, refreshToken };
}

export async function register(input: RegisterInput): Promise<{ user: PublicUser } & AuthTokens> {
  const [existingByEmail, existingByUsername] = await Promise.all([
    findUserByEmail(input.email),
    findUserByUsername(input.username),
  ]);

  if (existingByEmail) {
    throw new AppError(409, "email_taken", "Ese email ya está registrado");
  }
  if (existingByUsername) {
    throw new AppError(409, "username_taken", "Ese nombre de usuario ya está en uso");
  }

  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS);

  const client = await pool.connect();
  let user;
  try {
    await client.query("BEGIN");
    user = await createUser(
      { username: input.username, email: input.email, passwordHash },
      client
    );
    await createWalletForUser(user.id, client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const tokens = await issueTokens(user);
  return { user: toPublicUser(user), ...tokens };
}

export async function login(input: LoginInput): Promise<{ user: PublicUser } & AuthTokens> {
  const user = await findUserByEmail(input.email);

  // Mismo mensaje tanto si el email no existe como si la contraseña es incorrecta:
  // no queremos revelar qué emails están registrados.
  const invalidCredentialsError = new AppError(401, "invalid_credentials", "Email o contraseña incorrectos");

  if (!user || !user.is_active) {
    throw invalidCredentialsError;
  }

  const passwordMatches = await bcrypt.compare(input.password, user.password_hash);
  if (!passwordMatches) {
    throw invalidCredentialsError;
  }

  const tokens = await issueTokens(user);
  return { user: toPublicUser(user), ...tokens };
}

export async function refresh(refreshTokenInput: string): Promise<AuthTokens> {
  const tokenHash = hashToken(refreshTokenInput);
  const stored = await findRefreshTokenByHash(tokenHash);

  const invalidTokenError = new AppError(401, "invalid_refresh_token", "El refresh token no es válido");

  if (!stored || stored.revoked_at || stored.expires_at.getTime() < Date.now()) {
    throw invalidTokenError;
  }

  const user = await findUserById(stored.user_id);
  if (!user || !user.is_active) {
    throw invalidTokenError;
  }

  // Rotación: el token usado queda revocado y se emite uno nuevo.
  // Si alguien reutiliza un refresh token ya revocado, es señal de robo.
  await revokeRefreshToken(stored.id);

  return issueTokens(user);
}

export async function logout(refreshTokenInput: string): Promise<void> {
  const tokenHash = hashToken(refreshTokenInput);
  const stored = await findRefreshTokenByHash(tokenHash);
  if (stored && !stored.revoked_at) {
    await revokeRefreshToken(stored.id);
  }
  // Si el token no existe o ya estaba revocado, no es un error: el resultado
  // deseado (que ese token no sirva) ya se cumple.
}
