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

- **`Table`** (`modules/table/table.ts`) — una mesa con **capacidad fija** (2,
  3 o 4 jugadores) e **importe de ficha fijo** (`buyInCents`): todos los que
  se sientan lo hacen con el mismo dinero, para que la partida sea justa
  (antes cada jugador podía entrar con el saldo que le diera la gana). El
  stack de fichas de cada jugador **persiste entre manos** (estilo casino
  real: si ganas subes, si pierdes bajas) y solo se sincroniza con el wallet
  en dos momentos: al sentarse (se debita el buy-in) y al recomprar fichas
  si te quedas a 0 (`table:rebuy`, mismo importe). Si sales de la mesa, las
  fichas que te quedaran no se devuelven todavía (pendiente de decidir qué
  hacer con el saldo de un jugador ausente). Vive en memoria del proceso
  (válido para un solo servidor; escalar a varias instancias requeriría
  mover esto a Redis, pero la lógica no cambiaría).
- **`tableManager.ts`** — `findOrCreateRoom(capacity, buyInCents)`: busca una
  mesa abierta con esa configuración exacta (hueco libre, sin mano en curso)
  o crea una nueva. Las salas disponibles son fijas:
  `ROOM_CAPACITIES = [2, 3, 4]` y `BUY_IN_TIERS_EUROS = [1, 2, 4, 5, 8, 10, 20, 25, 50, 100, 250]`.
- **`socketServer.ts`** — servidor de Socket.io autenticado con el mismo
  access token JWT de `/auth/login`. Eventos:
  - Cliente → servidor: `table:join` `{capacity, buyInEuros}` (busca/crea
    sala y debita el buy-in), `table:rebuy` (si te quedaste a 0 fichas),
    `table:start`, `hand:action` (`{type: "pass"|"bet"|"call"|"raise"|"fold", amount?}`),
    `hand:discard` (`{cardIndexes: number[]}`), `table:leave`.
  - Servidor → cliente: `table:state` (estado personalizado: nunca incluye
    las cartas de otros jugadores durante la mano, salvo al terminar por
    showdown o póker de palo instantáneo, donde se revelan las manos de
    todos los que no se retiraron — igual que en una mesa física; incluye
    también `stacks` con las fichas actuales de cada jugador), `table:error`
    `{message}`.
- **Conexión con el wallet**: el wallet **solo se toca al sentarse o al
  recomprar fichas** (ambos son un `bet_debit` del importe de la mesa). Las
  apuestas de cada mano ya no tocan el wallet directamente: se mueven dentro
  del stack de fichas de la mesa (que el motor limita automáticamente al
  saldo real de cada jugador — ver all-in), y ese stack se sincroniza al
  terminar cada mano. Si no hay saldo suficiente para sentarse o recomprar,
  la acción se rechaza con un mensaje claro.

### Probarlo con los scripts de demo
Como probar WebSockets a mano con curl no es práctico, hay dos scripts:

```bash
# con el servidor ya corriendo en otra terminal (npm run dev)
npm run demo:table   # mesa de 2 jugadores con apuestas normales
npm run demo:allin   # ambos van all-in con el mismo importe, comprueba que el reparto de fichas cuadra
```

`demo:table` muestra el saldo de wallet antes y después de sentarse (se
debita el buy-in una sola vez) y cómo evoluciona el stack de fichas de la
mesa mano a mano, sin que el wallet vuelva a moverse hasta que alguien
recompre o se siente en otra mesa.

## Siguiente paso
Pendiente de decidir: qué hacer con las fichas de un jugador que abandona la
mesa (¿se devuelven al wallet al salir? ¿solo si no hay mano en curso?).
