import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { verifyAccessToken } from "../modules/auth/tokens";
import { GameRuleError } from "../modules/game/matchEngine";
import { DiscardAction, PlayerAction } from "../modules/game/types";
import { applyWalletTransaction } from "../modules/wallet/repository";
import { isInsufficientFundsError } from "../modules/wallet/service";
import {
  createPrivateRoom,
  findOrCreateRoom,
  findPrivateRoomByCode,
  getTable,
  isValidBuyInEuros,
  isValidCapacity,
} from "../modules/table/tableManager";
import { Table, TableError } from "../modules/table/table";

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

/** Segundos de pausa tras terminar una mano, para poder ver el resultado y las cartas del rival. */
const HAND_END_PAUSE_MS = 6000;

/** Segundos de cuenta atrás antes de la primera mano de la partida, en cuanto hay jugadores suficientes. */
const FIRST_HAND_COUNTDOWN_MS = 5000;

/** tableId -> temporizador pendiente para arrancar una mano (la primera, o la siguiente tras la pausa). */
const scheduledStarts = new Map<string, { timer: ReturnType<typeof setTimeout>; startAt: number }>();

function clearScheduledStart(tableId: string): void {
  const entry = scheduledStarts.get(tableId);
  if (entry) {
    clearTimeout(entry.timer);
    scheduledStarts.delete(tableId);
  }
}

function getScheduledStartAt(tableId: string): number | null {
  return scheduledStarts.get(tableId)?.startAt ?? null;
}

/**
 * Debita el importe de la mesa del wallet y sienta al jugador. Si sentarse
 * falla por cualquier motivo (mesa llena, etc.), devuelve el dinero para no
 * dejarlo debitado sin mesa. Deja pasar el error de saldo insuficiente y
 * cualquier otro para que el llamador decida el mensaje.
 */
async function debitAndSeat(userId: string, table: Table, buyInCents: number, reason: string): Promise<void> {
  await applyWalletTransaction({
    userId,
    amountCents: BigInt(-buyInCents),
    type: "bet_debit",
    metadata: { reason, tableId: table.id },
  });
  try {
    table.seatPlayerWithStack(userId, buyInCents);
  } catch (err) {
    await applyWalletTransaction({
      userId,
      amountCents: BigInt(buyInCents),
      type: "bet_credit",
      metadata: { reason: "buy_in_refund" },
    });
    throw err;
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
      const table = getTable(tableId);
      if (!table) return;
      const seatUsernames = table.seatOrder.map((id) => ({
        id,
        username: usernamesByUserId.get(id) ?? id,
      }));
      const startsAt = getScheduledStartAt(tableId);
      for (const playerId of table.seatOrder) {
        const target = socketsByUserId.get(playerId);
        if (target && target.currentTableId === tableId) {
          target.emit("table:state", { ...table.getPublicStateFor(playerId), seatUsernames, startsAt });
        }
      }
    }

    /**
     * Si hay jugadores suficientes para jugar y todavía no hay ninguna mano
     * en marcha ni una cuenta atrás ya programada, programa el inicio (de la
     * primera mano de la partida, o de la siguiente si la mesa acaba de
     * "revivir" tras una recompra) pasados FIRST_HAND_COUNTDOWN_MS — sin que
     * nadie tenga que pulsar ningún botón.
     */
    function maybeScheduleHandStart(tableId: string): void {
      const table = getTable(tableId);
      if (!table || table.currentHand || scheduledStarts.has(tableId) || !table.canStartHand()) return;
      const startAt = Date.now() + FIRST_HAND_COUNTDOWN_MS;
      const timer = setTimeout(() => {
        scheduledStarts.delete(tableId);
        const t = getTable(tableId);
        if (!t || t.currentHand || !t.canStartHand()) return;
        try {
          t.startHand();
        } catch {
          // no pasa nada: se quedará esperando a que haya jugadores suficientes
        }
        broadcastTableState(tableId);
      }, FIRST_HAND_COUNTDOWN_MS);
      scheduledStarts.set(tableId, { timer, startAt });
      broadcastTableState(tableId); // para que se vea la cuenta atrás desde ya
    }

    /**
     * Punto único para "cerrar el ciclo" tras cualquier cosa que pueda hacer
     * terminar una mano: difunde el estado (con el resultado y las cartas
     * reveladas, si las hay) y lo deja tal cual, SIN tocar nada más, durante
     * toda la pausa (HAND_END_PAUSE_MS) — así todo el mundo tiene tiempo de
     * verlo. Solo al final de esa pausa se sincronizan las fichas, se limpia
     * la mano, y si siguen quedando al menos 2 jugadores con fichas se
     * arranca la siguiente sola, sin que nadie tenga que pulsar nada. El
     * dinero de las apuestas nunca toca el wallet durante la mano — solo se
     * mueve dentro del stack de fichas de la mesa; el wallet se toca al
     * sentarse (buy-in), al volver a comprar fichas, y AQUÍ, en cuanto la
     * partida se da por terminada: se abona a cada jugador el stack final
     * que le quedara, una sola vez (si no, ese dinero se quedaría flotando
     * en la mesa para siempre sin volver nunca a su saldo real).
     */
    function settleAndBroadcast(tableId: string): void {
      const table = getTable(tableId);
      if (!table) return;
      const hand = table.currentHand;
      broadcastTableState(tableId);

      if (hand?.result) {
        clearScheduledStart(tableId);
        const startAt = Date.now() + HAND_END_PAUSE_MS;
        const timer = setTimeout(async () => {
          scheduledStarts.delete(tableId);
          const t = getTable(tableId);
          if (!t || t.currentHand !== hand) return; // algo raro cambió mientras tanto: no tocar nada
          t.finishHandCleanup();

          if (t.isGameOver() && !t.cachedStandings) {
            const standings = t.settleGameOverPayouts();
            // Se congela el nombre de usuario JUNTO con el resto de datos:
            // si alguien sale de la mesa después de ver el resultado, su
            // nombre no debe desaparecer de la clasificación de los demás.
            t.cachedStandings = standings.map((entry) => ({
              ...entry,
              username: usernamesByUserId.get(entry.userId) ?? entry.userId,
            }));
            for (const entry of standings) {
              if (entry.finalStackCents <= 0) continue;
              try {
                await applyWalletTransaction({
                  userId: entry.userId,
                  amountCents: BigInt(entry.finalStackCents),
                  type: "bet_credit",
                  metadata: { reason: "game_over_cashout", tableId },
                });
              } catch (err) {
                console.error(`No se pudo abonar el fin de partida a ${entry.userId} en ${tableId}:`, err);
              }
            }
            broadcastTableState(tableId);
          } else if (!t.isGameOver() && t.canStartHand()) {
            try {
              t.startHand();
            } catch {
              // no pasa nada: se quedará esperando a que haya jugadores suficientes
            }
            broadcastTableState(tableId);
          } else {
            broadcastTableState(tableId);
          }
        }, HAND_END_PAUSE_MS);
        scheduledStarts.set(tableId, { timer, startAt });
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

    socket.on("table:join", async (payload: { capacity: number; buyInEuros: number }) => {
      try {
        if (!isValidCapacity(payload.capacity)) {
          socket.emit("table:error", { message: "Ese número de jugadores no es una opción válida" });
          return;
        }
        if (!isValidBuyInEuros(payload.buyInEuros)) {
          socket.emit("table:error", { message: "Ese importe de mesa no es una opción válido" });
          return;
        }
        const buyInCents = Math.round(payload.buyInEuros * 100);
        const table: Table = findOrCreateRoom(payload.capacity, buyInCents);

        try {
          await debitAndSeat(socket.userId, table, buyInCents, "buy_in");
        } catch (err) {
          if (isInsufficientFundsError(err)) {
            socket.emit("table:error", {
              message: `Saldo insuficiente: necesitas al menos ${payload.buyInEuros} € para sentarte en esta mesa`,
            });
            return;
          }
          throw err;
        }

        socket.join(table.id);
        socket.currentTableId = table.id;
        broadcastTableState(table.id);
        maybeScheduleHandStart(table.id);
      } catch (err) {
        emitError(err, "No se pudo unir a la mesa");
      }
    });

    socket.on("table:createPrivate", async (payload: { capacity: number; buyInEuros: number }) => {
      try {
        if (!isValidCapacity(payload.capacity)) {
          socket.emit("table:error", { message: "Ese número de jugadores no es una opción válida" });
          return;
        }
        if (!isValidBuyInEuros(payload.buyInEuros)) {
          socket.emit("table:error", { message: "Ese importe de mesa no es una opción válido" });
          return;
        }
        const buyInCents = Math.round(payload.buyInEuros * 100);
        const table = createPrivateRoom(payload.capacity, buyInCents);

        try {
          await debitAndSeat(socket.userId, table, buyInCents, "buy_in");
        } catch (err) {
          if (isInsufficientFundsError(err)) {
            socket.emit("table:error", {
              message: `Saldo insuficiente: necesitas al menos ${payload.buyInEuros} € para crear esta sala`,
            });
            return;
          }
          throw err;
        }

        socket.join(table.id);
        socket.currentTableId = table.id;
        broadcastTableState(table.id);
        maybeScheduleHandStart(table.id);
      } catch (err) {
        emitError(err, "No se pudo crear la sala privada");
      }
    });

    socket.on("table:joinPrivate", async (payload: { code: string }) => {
      try {
        const table = findPrivateRoomByCode(payload.code ?? "");
        if (!table) {
          socket.emit("table:error", { message: "No existe ninguna sala privada con ese código" });
          return;
        }

        try {
          await debitAndSeat(socket.userId, table, table.buyInCents, "buy_in");
        } catch (err) {
          if (isInsufficientFundsError(err)) {
            socket.emit("table:error", {
              message: `Saldo insuficiente: esta sala necesita ${(table.buyInCents / 100).toFixed(2)} € para sentarte`,
            });
            return;
          }
          throw err;
        }

        socket.join(table.id);
        socket.currentTableId = table.id;
        broadcastTableState(table.id);
        maybeScheduleHandStart(table.id);
      } catch (err) {
        emitError(err, "No se pudo unir a la sala privada");
      }
    });

    socket.on("table:rebuy", async () => {
      const tableId = socket.currentTableId;
      if (!tableId) {
        socket.emit("table:error", { message: "No estás en ninguna mesa" });
        return;
      }
      const table = getTable(tableId);
      if (!table) return;
      try {
        if (!table.canRebuy(socket.userId)) {
          socket.emit("table:error", { message: "No puedes volver a comprar fichas ahora mismo" });
          return;
        }
        try {
          await applyWalletTransaction({
            userId: socket.userId,
            amountCents: BigInt(-table.buyInCents),
            type: "bet_debit",
            metadata: { reason: "rebuy", tableId },
          });
        } catch (err) {
          if (isInsufficientFundsError(err)) {
            socket.emit("table:error", { message: "Saldo insuficiente para volver a comprar fichas" });
            return;
          }
          throw err;
        }
        table.rebuy(socket.userId);
        broadcastTableState(tableId);
        maybeScheduleHandStart(tableId);
      } catch (err) {
        emitError(err, "No se pudo completar la recompra de fichas");
      }
    });

    socket.on("table:start", () => {
      const tableId = socket.currentTableId;
      if (!tableId) {
        socket.emit("table:error", { message: "No estás en ninguna mesa" });
        return;
      }
      const table = getTable(tableId);
      if (!table) return;
      try {
        table.startHand();
        broadcastTableState(tableId);
      } catch (err) {
        emitError(err, "No se pudo iniciar la mano");
      }
    });

    socket.on("hand:action", (action: PlayerAction) => {
      const tableId = socket.currentTableId;
      if (!tableId) return;
      const table = getTable(tableId);
      if (!table) return;
      const hand = table.currentHand;
      if (!hand) {
        socket.emit("table:error", { message: "No hay ninguna mano en curso" });
        return;
      }
      try {
        // El motor ya conoce el stack de fichas de cada jugador (fijado al
        // iniciar la mano) y limita cualquier apuesta a lo que le queda; el
        // dinero se mueve solo dentro de ese stack, nunca contra el wallet
        // directamente aquí.
        hand.applyAction(socket.userId, action);
        settleAndBroadcast(tableId);
      } catch (err) {
        emitError(err, "No se pudo procesar la acción");
      }
    });

    socket.on("hand:discard", (discard: DiscardAction) => {
      const tableId = socket.currentTableId;
      if (!tableId) return;
      const table = getTable(tableId);
      if (!table) return;
      const hand = table.currentHand;
      if (!hand) {
        socket.emit("table:error", { message: "No hay ninguna mano en curso" });
        return;
      }
      try {
        hand.applyDiscard(socket.userId, discard);
        settleAndBroadcast(tableId);
      } catch (err) {
        emitError(err, "No se pudo procesar el descarte");
      }
    });

    socket.on("table:leave", () => {
      const tableId = socket.currentTableId;
      if (!tableId) return;
      const table = getTable(tableId);
      if (table) {
        table.removePlayer(socket.userId);
        if (table.seatOrder.length < 2) clearScheduledStart(tableId);
      }
      socket.leave(tableId);
      socket.currentTableId = null;
      if (table) broadcastTableState(tableId);
    });

    socket.on("disconnect", () => {
      if (socketsByUserId.get(socket.userId) === socket) {
        socketsByUserId.delete(socket.userId);
      }
      const tableId = socket.currentTableId;
      if (tableId) {
        const table = getTable(tableId);
        if (table) {
          table.markDisconnected(socket.userId);
          broadcastTableState(tableId);
        }
      }
    });
  });

  return io;
}
