-- Esquema inicial: usuarios
-- Cada paso futuro (wallet, partidas...) añadirá su propio bloque a este archivo
-- o a un nuevo archivo de migración numerado en db/migrations.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(20) NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active       BOOLEAN NOT NULL DEFAULT true
);

-- Restricciones básicas de formato para evitar basura desde el registro
ALTER TABLE users
    ADD CONSTRAINT username_format CHECK (username ~ '^[a-zA-Z0-9_]{3,20}$');

ALTER TABLE users
    ADD CONSTRAINT email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- Tokens de refresco para el login persistente (rotan en cada uso)
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
