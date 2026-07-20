import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { verifyAccessToken } from "../modules/auth/tokens";
import { GameRuleError, GileHand } from "../modules/game/matchEngine";
import { DiscardAction, PlayerAction } from "../modules/game/types";
import { applyWalletTransaction, getWallet } from "../modules/wallet/repository";
import { getOrCreateTable } from "../modules/table/tableManager";
import { TableError } from "../modules/table/table";

interface AuthedSocket extends Socket {
  userId: string;
  username: string;
  currentTableId: string | null;
}

/**
 * userId -> socket conectado. Solo se admite una conexión activa por usuario;
 * si se conecta desde otro sitio, la conexión anterior queda "huérfana" (no
 * se cierra a la fuerza aquí, pero deja de recibir table:state).
 */
const socketsByUserId = new Map<string, AuthedSocket>();

/** userId -> username, para poder mostrar nombres en vez de UUIDs en el cliente. */
const usernamesByUserId = new Map<string, string>();

/**
 * Si la mano acaba de terminar (por el motivo que sea: showdown, retirada de
 * todos menos uno, o victoria instantánea por póker de palo), paga a quien
 * corresponda según hand.result.payouts. Se llama SIEMPRE que una acción
 * pueda hacer terminar la mano — tanto al apostar como al descartar, ya que
 * con el bloqueo de apuestas por all-in la mano puede terminar directamente
 * durante el descarte, sin pasar por otra acción de apuesta.
 */
async function settlePayoutsIfFinished(hand: GileHand, tableId: string): Promise<void> {
  if (!hand.result) return;
  for (const payout of hand.result.payouts) {
    if (payout.amount <= 0) continue;
    await applyWalletTransaction({
      userId: payout.playerId,
      amountCents: BigInt(payout.amount),
      type: "bet_credit",
      metadata: { tableId, reason: hand.result.reason },
    });
  }
}

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" }, // TODO: restringir a los orígenes reales del cliente en producción
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.["token"] as string | undefined;
    if (!token) {
      next(new Error("Falta el token de autenticación"));
      return;
    }
    try {
      const payload = verifyAccessToken(token);
      (socket as AuthedSocket).userId = payload.sub;
      (socket as AuthedSocket).username = payload.username;
      (socket as AuthedSocket).currentTableId = null;
      next();
    } catch {
      next(new Error("Token de autenticación inválido o caducado"));
    }
  });

  io.on("connection", (rawSocket) => {
    const socket = rawSocket as AuthedSocket;
    socketsByUserId.set(socket.userId, socket);
    usernamesByUserId.set(socket.userId, socket.username);

    function broadcastTableState(tableId: string): void {
      const table = getOrCreateTable(tableId);
      const seatUsernames = table.seatOrder.map((id) => ({
        id,
        username: usernamesByUserId.get(id) ?? id,
      }));
      for (const playerId of table.seatOrder) {
        const target = socketsByUserId.get(playerId);
        if (target && target.currentTableId === tableId) {
          target.emit("table:state", { ...table.getPublicStateFor(playerId), seatUsernames });
        }
      }
    }

    /**
     * Punto único para "cerrar el ciclo" tras cualquier cosa que pueda hacer
     * terminar una mano (apostar, descartar, o que alguien se desconecte y
     * gane por retirada forzosa de los demás): liquida pagos si hay
     * resultado, difunde el estado (con el resultado, si lo hay) y solo
     * después limpia la mano de la mesa.
     */
    async function settleAndBroadcast(tableId: string): Promise<void> {
      const table = getOrCreateTable(tableId);
      const hand = table.currentHand;
      if (hand) {
        await settlePayoutsIfFinished(hand, tableId);
      }
      broadcastTableState(tableId);
      if (hand?.result) {
        table.finishHandCleanup();
      }
    }
    function emitError(err: unknown, fallbackMessage: string): void {
      if (err instanceof GameRuleError || err instanceof TableError) {
        socket.emit("table:error", { message: err.message });
        return;
      }
      console.error("Error inesperado en el socket:", err);
      socket.emit("table:error", { message: fallbackMessage });
    }

    socket.on("table:join", (payload: { tableId: string }) => {
      try {
        const table = getOrCreateTable(payload.tableId);
        table.addPlayer(socket.userId);
        socket.join(payload.tableId);
        socket.currentTableId = payload.tableId;
        broadcastTableState(payload.tableId);
      } catch (err) {
        emitError(err, "No se pudo unir a la mesa");
      }
    });

    socket.on("table:start", async () => {
      const tableId = socket.currentTableId;
      if (!tableId) {
        socket.emit("table:error", { message: "No estás en ninguna mesa" });
        return;
      }
      try {
        const table = getOrCreateTable(tableId);
        // El stack de cada jugador para esta mano es una foto fija de su
        // saldo actual del wallet — igual que las fichas que alguien tiene
        // delante en una mesa física, no cambia aunque su saldo real
        // fluctúe por otro lado mientras juega esta mano.
        const stacks: Record<string, number> = {};
        for (const playerId of table.seatOrder) {
          const wallet = await getWallet(playerId);
          stacks[playerId] = wallet ? Number(wallet.balance_cents) : 0;
        }
        table.startHand(stacks);
        broadcastTableState(tableId);
      } catch (err) {
        emitError(err, "No se pudo iniciar la mano");
      }
    });

    socket.on("hand:action", async (action: PlayerAction) => {
      const tableId = socket.currentTableId;
      if (!tableId) return;
      const table = getOrCreateTable(tableId);
      const hand = table.currentHand;
      if (!hand) {
        socket.emit("table:error", { message: "No hay ninguna mano en curso" });
        return;
      }

      try {
        // El motor ya conoce el stack de cada jugador (fijado al iniciar la
        // mano) y limita cualquier apuesta a lo que le queda, así que esto
        // nunca debería exceder su saldo real: se aplica primero al motor y
        // se debita exactamente lo que se comprometió de verdad.
        const committed = hand.applyAction(socket.userId, action);

        if (committed > 0) {
          await applyWalletTransaction({
            userId: socket.userId,
            amountCents: BigInt(-committed),
            type: "bet_debit",
            metadata: { tableId },
          });
        }

        await settleAndBroadcast(tableId);
      } catch (err) {
        emitError(err, "No se pudo procesar la acción");
      }
    });

    socket.on("hand:discard", async (discard: DiscardAction) => {
      const tableId = socket.currentTableId;
      if (!tableId) return;
      const table = getOrCreateTable(tableId);
      const hand = table.currentHand;
      if (!hand) {
        socket.emit("table:error", { message: "No hay ninguna mano en curso" });
        return;
      }
      try {
        hand.applyDiscard(socket.userId, discard);
        await settleAndBroadcast(tableId);
      } catch (err) {
        emitError(err, "No se pudo procesar el descarte");
      }
    });

    socket.on("table:leave", async () => {
      const tableId = socket.currentTableId;
      if (!tableId) return;
      const table = getOrCreateTable(tableId);
      table.removePlayer(socket.userId);
      socket.leave(tableId);
      socket.currentTableId = null;
      await settleAndBroadcast(tableId);
    });

    socket.on("disconnect", async () => {
      if (socketsByUserId.get(socket.userId) === socket) {
        socketsByUserId.delete(socket.userId);
      }
      const tableId = socket.currentTableId;
      if (tableId) {
        const table = getOrCreateTable(tableId);
        table.markDisconnected(socket.userId);
        await settleAndBroadcast(tableId);
      }
    });
  });

  return io;
}
