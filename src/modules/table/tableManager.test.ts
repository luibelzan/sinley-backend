import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateRoom, findOrCreateRoom, findPrivateRoomByCode } from "./tableManager";

test("findOrCreateRoom nunca devuelve una mesa privada, aunque coincida capacidad e importe", () => {
  const priv = createPrivateRoom(2, 1000);
  // Una mesa pública nueva con la misma configuración no debe reutilizar la privada.
  const pub = findOrCreateRoom(2, 1000);
  assert.notEqual(pub.id, priv.id);
  assert.equal(pub.isPrivate, false);
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
