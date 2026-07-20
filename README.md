# Card game backend

## Pasos completados
1. Base del proyecto (servidor Express + TypeScript, Postgres, Redis)
2. Autenticación (registro, login, refresh, logout con JWT + refresh tokens)
3. Saldo virtual (wallet con recarga simulada y ledger de transacciones)
4. Motor del juego (máquina de estados de una mano completa, reglamento de Sin Ley)
5. Capa en tiempo real (WebSockets, mesas, conexión con el wallet)

## Cómo levantarlo

1. Instalar dependencias:
   ```bash
   npm install
   ```

2. Copiar el archivo de entorno y ajustar los secretos:
   ```bash
   cp .env.example .env
   ```

3. Levantar Postgres y Redis (con Docker, o de forma nativa — ver conversación previa).

4. Aplicar las migraciones pendientes (esto ahora es incremental: puedes ejecutarlo
   las veces que quieras, solo aplica lo que falte):
   ```bash
   npx ts-node src/db/migrate.ts
   ```

5. Arrancar el servidor en modo desarrollo:
   ```bash
   npm run dev
   ```

## Endpoints disponibles

### Autenticación (`/auth`)
- `POST /auth/register` — `{ username, email, password }`
- `POST /auth/login` — `{ email, password }`
- `POST /auth/refresh` — `{ refreshToken }`
- `POST /auth/logout` — `{ refreshToken }`

### Wallet (`/wallet`, requieren `Authorization: Bearer <accessToken>`)
- `GET /wallet/me` — saldo actual
- `POST /wallet/recharge` — `{ amount }` (en unidades, ej. euros; recarga simulada, se acredita directamente)
- `GET /wallet/transactions` — historial de movimientos (ledger)

## Sistema de migraciones
Cada cambio de esquema vive en `db/migrations/NNN_descripcion.sql`, numerado en orden.
`src/db/migrate.ts` lleva un registro en la tabla `schema_migrations` de qué archivos
ya se aplicaron, así que ejecutarlo varias veces es seguro: solo aplica los nuevos.

## Motor del juego (`src/modules/game/`)
Implementa el reglamento oficial de **Sin Ley**. Lógica pura, sin dependencias
de base de datos ni de red — se testea sola y se conectará a WebSockets en el
próximo paso:

- `types.ts` — palos, cartas (baraja de 32: As, Tres, Cinco comodín, Siete,
  Diez, Sota, Caballero, Rey), fases y tipos de acción. 2 a 4 jugadores.
- `deck.ts` — mazo y barajado con RNG criptográfico.
- `handEvaluator.ts` — puntuación de una mano de 4 cartas: Sin Ley Real (4
  ases) > Sin Ley (3 ases) > puntuación por palo (solo cuentan las cartas del
  palo que dé más puntos; el Cinco comodín se suma al palo que más convenga).
  Todas las cartas valen 10 salvo el As (11) y el Siete (7).
- `matchEngine.ts` — clase `GileHand`: máquina de estados completa de una mano
  (reparto → ronda 1 → reparto adicional → ronda 2 → [victoria automática si
  hay póker de palo] → descarte → ronda final → showdown), con desempate por
  privilegio del repartidor (regla oficial) y una variante opcional de rango
  de palos.

### All-in y botes divididos

Cada mano recibe un `stacks: Record<userId, saldoEnCéntimos>` al crearse — una
foto fija del saldo de cada jugador en ese momento, igual que las fichas que
alguien tiene delante en una mesa física. A partir de ahí:

- Ninguna apuesta puede superar el stack de quien la hace: si pide más de lo
  que le queda, se le aporta automáticamente todo lo que tiene (all-in) en vez
  de rechazar la acción.
- En cuanto a un jugador ya no le queda nada que aportar, dos cosas cambian:
  deja de tener turno (nunca se le vuelve a pedir que actúe, pero sigue en la
  mano), y en cuanto ya no queda más de un jugador con capacidad de seguir
  apostando, **todas las rondas de apuestas restantes se saltan automáticamente**
  — se reparten las cartas que falten y se completa el descarte con
  normalidad, pero sin pedir ninguna apuesta más, hasta llegar al showdown.
- Si varios jugadores quedan all-in por distintas cantidades, el bote se
  divide en capas (`computePotLayers`): cada capa solo la pueden ganar los
  jugadores que llegaron a aportar hasta ese nivel, así que un jugador corto
  de fichas nunca puede llevarse más de lo que le corresponde por lo que
  puso — el resultado de la mano (`HandResult.payouts`) puede repartirse
  entre más de un jugador.
- `applyAction` devuelve cuánto se aportó **de verdad** al bote (ya limitado
  al stack), y es exactamente esa cantidad la que la capa de sockets debita
  del wallet — nunca la cantidad nominal que el jugador pidió.

**Nota**: con la baraja de 32 cartas, el peor caso posible (4 jugadores
descartando las 4 cartas cada uno = 16 cartas) encaja justo con las 16 que
quedan en el mazo en ese punto, así que ya no hay riesgo de quedarse sin
cartas en el descarte. El motor conserva de todas formas una comprobación
explícita que lanzaría un `GameRuleError` claro si esto cambiara en el futuro.

Correr los tests:
```bash
npm test
```

## Tiempo real (`src/realtime/`, `src/modules/table/`)

- **`Table`** (`modules/table/table.ts`) — jugadores sentados, rotación del
  repartidor, ciclo de vida de la `GileHand` actual. Vive en memoria del
  proceso (válido para un solo servidor; escalar a varias instancias
  requeriría mover esto a Redis, pero la lógica no cambiaría).
- **`socketServer.ts`** — servidor de Socket.io autenticado con el mismo
  access token JWT de `/auth/login`. Eventos:
  - Cliente → servidor: `table:join` `{tableId}`, `table:start`, `hand:action`
    (`{type: "pass"|"bet"|"call"|"raise"|"fold", amount?}`), `hand:discard`
    (`{cardIndexes: number[]}`), `table:leave`.
  - Servidor → cliente: `table:state` (estado personalizado: nunca incluye
    las cartas de otros jugadores durante la mano, salvo al terminar por
    showdown o póker de palo instantáneo, donde se revelan las manos de
    todos los que no se retiraron — igual que en una mesa física), `table:error`
    `{message}`.
- **Conexión con el wallet**: antes de aplicar cualquier `bet`/`call`/`raise`
  al motor, se debita el wallet del jugador (`bet_debit`); si no hay saldo
  suficiente, la acción se rechaza y el motor ni se entera. Al terminar la
  mano, el bote se acredita al ganador (`bet_credit`). Todo queda registrado
  en `wallet_transactions` como cualquier otro movimiento.

### Probarlo con el script de demo
Como probar WebSockets a mano con curl no es práctico, hay un script que
simula una mesa de 2 jugadores completa, con decisiones automáticas simples
(apuesta fija, igualar, no descartar nada), mostrando el saldo real antes y
después:

```bash
# con el servidor ya corriendo en otra terminal (npm run dev)
npm run demo:table
```

Deberías ver algo como:
```
Registrando y recargando a dos jugadores de prueba...
Saldo inicial ana: 50
Saldo inicial beto: 50
[ana] conectado, uniéndose a la mesa demo-table-...
[beto] conectado, uniéndose a la mesa demo-table-...
Iniciando la mano...
[beto] fase=betting_1 pot=0 -> {"type":"bet","amount":100}
[ana] fase=betting_1 pot=100 -> {"type":"call"}
...
Resultado de la mano: { winnerId: '...', pot: ..., reason: 'showdown', ... }
Saldo final ana: ...
Saldo final beto: ...
```

## Siguiente paso
Paso 6: frontend — cliente React que se conecta a la autenticación, el wallet
y la mesa en tiempo real.
