import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "http";
import { env } from "./config/env";
import { checkDatabaseConnection } from "./db/pool";
import { authRouter } from "./modules/auth/routes";
import { walletRouter } from "./modules/wallet/routes";
import { requireAuth } from "./middleware/requireAuth";
import { errorHandler } from "./middleware/errorHandler";
import { initSocketServer } from "./realtime/socketServer";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/health", async (_req, res) => {
  const dbOk = await checkDatabaseConnection();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    database: dbOk ? "connected" : "unreachable",
    timestamp: new Date().toISOString(),
  });
});

app.use("/auth", authRouter);
app.use("/wallet", walletRouter);

// Endpoint de prueba para comprobar que requireAuth funciona correctamente.
// Lo sustituiremos por endpoints reales (perfil, saldo...) en próximos pasos.
app.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// El manejador de errores va siempre al final, después de todas las rutas.
app.use(errorHandler);

const httpServer = createServer(app);
initSocketServer(httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${env.PORT} (HTTP + WebSocket)`);
});
