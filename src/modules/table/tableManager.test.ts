import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateRoom, findOrCreateRoom, findPrivateRoomByCode } from "./tableManager";
import { GamePhase } from "../game/types";

test("findOrCreateRoom nunca devuelve una mesa privada, aunque coincida capacidad e importe", () => {
  const priv = createPrivateRoom(2, 1000);
  // Una mesa pública nueva con la misma configuración no debe reutilizar la privada.
  const pub = findOrCreateRoom(2, 1000);
  assert.notEqual(pub.id, priv.id);
  assert.equal(pub.isPrivate, false);
});

test("findOrCreateRoom nunca reutiliza una mesa cuya partida ya terminó, aunque tenga hueco libre", () => {
  const table = findOrCreateRoom(2, 1500);
  table.seatPlayerWithStack("ana", 1500);
  table.seatPlayerWithStack("beto", 1500);

  const hand = table.startHand();
  hand.applyAction("beto", { type: "bet", amount: 999_999 }); // all-in
  hand.applyAction("ana", { type: "raise", amount: 999_999 }); // all-in también
  if (hand.phase === GamePhase.DISCARD) {
    hand.applyDiscard("beto", { cardIndexes: [] });
    hand.applyDiscard("ana", { cardIndexes: [] });
  }
  table.finishHandCleanup();
  assert.equal(table.isGameOver(), true);

  // El que ganó pulsa "salir" (vuelve al panel con normalidad)...
  const winnerId = table.stacks.get("ana") === 0 ? "beto" : "ana";
  const loserId = winnerId === "ana" ? "beto" : "ana";
  table.removePlayer(winnerId);
  // ...pero el que perdió nunca pulsa nada (cierra la pestaña sin más):
  // se queda sentado como jugador "fantasma", con sus fichas a 0.
  assert.equal(table.seatOrder.includes(loserId), true);
  assert.equal(table.seatOrder.length, 1);

  // Alguien más busca mesa con la MISMA configuración: no debe reutilizar
  // esta mesa "fantasma", aunque tenga hueco libre (1 < 2) y no haya mano en curso.
  const newTable = findOrCreateRoom(2, 1500);
  assert.notEqual(newTable.id, table.id);
});

test("createPrivateRoom genera un código único, sin caracteres ambiguos", () => {
  const table = createPrivateRoom(3, 2000);
  assert.equal(table.isPrivate, true);
  assert.ok(table.code);
  assert.equal(table.code!.length, 6);
  assert.ok(!/[O0I1]/.test(table.code!), "el código no debería usar caracteres ambiguos (O/0, I/1)");
});

test("findPrivateRoomByCode encuentra la sala y no distingue mayúsculas/minúsculas", () => {
  const table = createPrivateRoom(2, 500);
  const found = findPrivateRoomByCode(table.code!.toLowerCase());
  assert.equal(found?.id, table.id);
});

test("findPrivateRoomByCode devuelve undefined si el código no existe", () => {
  const found = findPrivateRoomByCode("ZZZZZZ");
  assert.equal(found, undefined);
});
