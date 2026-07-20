import { PoolClient } from "pg";
import { pool } from "../../db/pool";

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  created_at: Date;
  is_active: boolean;
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const { rows } = await pool.query<UserRecord>(
    "SELECT * FROM users WHERE email = $1",
    [email]
  );
  return rows[0] ?? null;
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const { rows } = await pool.query<UserRecord>(
    "SELECT * FROM users WHERE username = $1",
    [username]
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const { rows } = await pool.query<UserRecord>(
    "SELECT * FROM users WHERE id = $1",
    [id]
  );
  return rows[0] ?? null;
}

export async function createUser(
  params: { username: string; email: string; passwordHash: string },
  client?: PoolClient
): Promise<UserRecord> {
  const runner = client ?? pool;
  const { rows } = await runner.query<UserRecord>(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.username, params.email, params.passwordHash]
  );
  const user = rows[0];
  if (!user) {
    throw new Error("No se pudo crear el usuario");
  }
  return user;
}

export async function storeRefreshToken(params: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [params.userId, params.tokenHash, params.expiresAt]
  );
}

export interface RefreshTokenRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
  const { rows } = await pool.query<RefreshTokenRecord>(
    "SELECT * FROM refresh_tokens WHERE token_hash = $1",
    [tokenHash]
  );
  return rows[0] ?? null;
}

export async function revokeRefreshToken(id: string): Promise<void> {
  await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [id]);
}

export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  await pool.query(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  );
}
