# AGENTS.md — Sistema distribuido Coordinadores / Workers (G8)

Documento de normas para agentes (IA o humanos) que modifiquen este repositorio.
Autores: Becerra Morales Paula Selene (capacidad 6) · Castillo Jiménez Juan Diego (capacidad 5).

---

## 0. Reglas de oro (leer primero)

1. **No romper lo que ya funciona.** Elección Bully, gossip de peers, descubrimiento local, `onlyLeader`, heartbeat, búsqueda de líder del worker y las UIs actuales deben seguir funcionando igual.
2. **Cambios mínimos y aditivos.** Añadir endpoints, campos y funciones nuevas. No renombrar, no reordenar, no reescribir funciones existentes salvo las listadas en la sección 3.
3. **Cada modificación a código existente debe estar en la sección 3.** Si algo no está ahí, no se toca. Si un agente cree que hace falta otro cambio, lo propone, no lo aplica.
4. **No cambiar contratos de red existentes** (`/election/*`, `/register`, `/heartbeat/:name`, `/pulse/:name`, `/servers`, respuestas 409/503 de `onlyLeader`). Otros compañeros corren sus propias implementaciones contra las nuestras el día del parcial.
5. **Todo en memoria**, sin bases de datos ni dependencias nuevas (solo `express` y `axios`, que ya están).
6. **Comentarios y logs en español**, con el mismo estilo actual (`logCoord(...)` en el coordinador, `logActivity(...)` en el worker).
7. **Los únicos parámetros de consola** son: `node index.js {PUERTO} {URL_NGROK}`. Todo lo demás (ID, semillas, coordinador inicial, lag) se configura por `.env` o por la UI.

---

## 1. Arquitectura actual (resumen)

| Componente | Archivo | Rol |
|---|---|---|
| Coordinador | `index.js` (+ `public/` con la UI del dashboard) | Elección Bully, gossip de peers, registro de workers, heartbeats, mensajes. Solo el **líder** atiende `/register`, `/heartbeat`, `/pulse`, `/send-message`. |
| Worker | `index.js` (UI HTML embebida en `GET /`) | Se registra con el líder, envía pulsos, detecta caída del líder y busca uno nuevo (`findNewLeader`). |

Flujo de líder ya implementado (no tocar):
- Un follower responde **409** `{leader, peers}` (camino rápido) o **503** si hay elección (camino lento).
- El worker reacciona en `handleCoordinatorError` → `registerWithLeader` / `findNewLeader`.

Estado clave del coordinador: `role`, `currentLeader`, `currentTerm`, `peers`, `servers`, `allMessages`.
Estado clave del worker: `NAME`, `PORT`, `MY_WORKER_URL`, `currentCoordinatorUrl`, `knownCoordinators`, `activityLogs`.

---

## 2. Identidad y arranque

- IDs obligatorios:
  - Worker: `worker-{nombre}-{código}` → ej. `worker-juan-55217003`
  - Coordinador: **se mantiene el esquema actual**, un ID de una letra (`A`, `B`, `C`, `D`, ...) definido por convención entre compañeros al momento de arrancar cada nodo. No se usa `coordinator-{nombre}-{código}` para el arranque ni para `NODE_ID`.
- **Coordinador:** arranque sin cambios respecto al código actual: `node index.js {ID_LETRA} {PUERTO} {SEED_URL}` → ej. `node index.js A 3000` o `node index.js C 3002 http://localhost:3000`. `NODE_ID` sigue tomándose de `process.argv[2]` y `MY_URL` sigue resolviéndose como hoy (con `PUBLIC_URL`/`PUBLIC_URL_{ID}` si se usa ngrok). **No aplica el comando único `node index.js {PUERTO} {URL_NGROK}` al coordinador.**
- **Worker:** sí usa el comando único: `node index.js {PUERTO} {URL_NGROK}`
  - Ej.: `node index.js 4000 https://nombre-random.ngrok.dev`
  - El nombre del worker (`NAME`) se lee de `.env` (`WORKER_ID`), no de la consola.

---

## 3. Cambios obligatorios sobre código existente

Todo lo demás es código nuevo (sección 4).

### 3.1 Coordinador (`index.js`)

| # | Dónde | Cambio | Motivo |
|---|---|---|---|
| C2 | `isHigherPriority` | Reemplazar `localeCompare` por comparación determinista: `String(id1) > String(id2)`. Mantener la rama numérica. | `localeCompare` depende del idioma del SO; con máquinas distintas podría dar órdenes diferentes → dos líderes. |
| C3 | `getLeaderUrl` (fallback `portGuess`) y `probeLocalPeers` (`String.fromCharCode`) | Sin cambios funcionales: como el ID sigue siendo una letra (`A`, `B`, `C`...), este fallback letra→puerto se mantiene exactamente como está hoy. Se deja documentado aquí solo para que no se toque por error al tocar cosas cercanas. | Evitar que se "corrija" algo que no está roto. |
| C4 | Constantes de tiempo | Alinear a la sección 5 (ver tabla). Extraerlas a constantes arriba del archivo. | Tiempos exigidos por el parcial. |
| C5 | `sendPeerPings` (catch) | Quitar el atajo `|| elapsed > 4000`; eliminar un peer solo tras `failCount >= PING_RETRIES` (3). | El atajo contradice "Ping retries: 3". |
| C6 | `POST /register` | Guardar `capabilities` si vienen en el body: `capabilities: req.body.capabilities \|\| servers[name]?.capabilities \|\| []`. | El líder necesita conocer capacidades para asignar. |
| C7 | `GET /servers`, `GET /api/stats` | Incluir `capabilities` en cada servidor devuelto (spread ya lo hace en `/servers`; agregar en `/api/stats.serverList`). | La UI debe mostrarlas. |

### 3.2 Worker (`index.js`)

| # | Dónde | Cambio | Motivo |
|---|---|---|---|
| W1 | Parseo de `PORT`, `NAME`, `MY_WORKER_URL`, `currentCoordinatorUrl` | Si `argv[3]` empieza con `http` → modo nuevo: `PORT=argv[2]`, `MY_WORKER_URL=argv[3]`, `NAME=process.env.WORKER_ID`, coordinador inicial = `process.env.PUBLIC_URL` o `http://localhost:3000` (luego se cambia desde la UI "Cambiar de coordinador a mano"). Si no → **modo legado** actual. | Comando único. |
| W2 | `registerWithLeader` | Enviar también `capabilities: CAPABILITIES` en el body de `/register`. | Publicar capacidades al líder. |
| W3 | `sendPulse` | Tras un pulso exitoso, llamar `flushPendingResults()` (código nuevo, sección 4.3). | Reenviar resultados que quedaron pendientes por caída del líder. |
| W4 | Tiempos | `apiClient.timeout` → `PULSE_TIMEOUT_MS` (8000); `setInterval(sendPulse, …)` → `PULSE_INTERVAL_MS` (3000). Reintentos: ver 5.2. | Sección 5. |
| W5 | `GET /` (HTML) y `/worker-state` | Añadir (sin quitar nada): lista de capacidades, campo para editar el lag, y tabla de tareas recibidas. `/worker-state` suma `capabilities`, `taskDelayMs`, `tasks`. | UI debe reflejar tareas. |

---

## 4. Especificación de tareas (código nuevo)

### 4.1 Endpoints

| Endpoint | Vive en | Lo llama | Auth de líder |
|---|---|---|---|
| `POST /task/assign` | **Worker** | Coordinador (líder) | — |
| `POST /task/receive` | **Coordinador** | Worker → su líder | `onlyLeader` |
| `GET /task/capabilities` | **Worker** | Coordinador / UI | — |

Endpoints auxiliares nuevos (para la UI, todos aditivos):

| Endpoint | Vive en | Función |
|---|---|---|
| `POST /api/tasks` | Coordinador (`onlyLeader`) | La UI crea y despacha una tarea. Body: `{ type, payload, worker? }`. |
| `GET /api/tasks` | Coordinador | Lista de tareas y su estado. |
| `POST /task/config` | Worker | Cambia el lag en caliente. Body: `{ delayMs }`. |

### 4.2 Mensajes (formato fijo del parcial — no alterar nombres de campos)

**Coordinador → Worker** (`POST {worker}/task/assign`)
```json
{
  "type": "task-assign",
  "data": {
    "taskId": "task-123",
    "type": "vector_distance",
    "payload": { "a": [0, 0], "b": [3, 4] }
  }
}
```
Respuesta inmediata del worker: `202 { "ok": true, "taskId": "task-123" }`.
Si la capacidad no existe: `400 { "ok": false, "error": "Capacidad no soportada: xxx" }`.

**Worker → Coordinador** (`POST {líder}/task/receive`)
```json
{ "type": "task-result", "data": { "taskId": "task-123", "status": "ok", "result": { "distance": 5 } } }
```
```json
{ "type": "task-result", "data": { "taskId": "task-123", "status": "error", "error": "Ocurrió un error por estas razones..." } }
```
Respuesta del coordinador: `200 { "ok": true }`; `404` si el `taskId` no existe.

**`GET /task/capabilities`** (Worker)
```json
{ "worker": "worker-juandiego-55217003", "capabilities": ["vector_distance"] }
```
(Ejemplo del worker de Paula: `{"worker":"worker-paula-...","capabilities":["http_latency"]}`. Ver tabla 4.5.1: nunca las dos capacidades en el mismo worker.)

### 4.3 Comportamiento del Worker

- **Capacidad única por instancia.** Cada worker implementa **solo la capacidad que le corresponde a su autor** (ver tabla 4.5.1). No se debe declarar ni ejecutar la capacidad del compañero en el mismo proceso, aunque el código de ambos ejecutores viva en el mismo repo (por reutilización), para que cada quien controle y demuestre su propia implementación el día del parcial.
- `CAPABILITIES` se define por variable de entorno, **no** como arreglo fijo con las dos capacidades:
  ```js
  // .env del worker de Juan Diego: WORKER_CAPABILITIES=vector_distance
  // .env del worker de Paula:      WORKER_CAPABILITIES=http_latency
  const CAPABILITIES = (process.env.WORKER_CAPABILITIES || "vector_distance")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  ```
  Si `WORKER_CAPABILITIES` no está definida, no arrancar con las dos por defecto: usar un único valor por defecto documentado (o exigir la variable y salir con error si falta, a elección del equipo, pero nunca `["vector_distance","http_latency"]` juntas).
- El registro con el líder (`POST /register`, W2) y `GET /task/capabilities` deben reportar exactamente el arreglo `CAPABILITIES` resultante (una sola capacidad en cada worker real del parcial).
- **Lag configurable:** `TASK_DELAY_MS` (env, por defecto `3000`), modificable en runtime con `POST /task/config` y desde la UI.
- Flujo de `POST /task/assign`:
  1. Validar `type === "task-assign"` y `data.taskId/type/payload`. Rechazar con 400 si falla o si la capacidad no existe.
  2. Responder `202` de inmediato (no bloquear la petición durante el lag).
  3. Ejecutar la tarea **primero** (para que `http_latency` no incluya el lag) y **luego** esperar el tiempo restante de `TASK_DELAY_MS`.
  4. Enviar `task-result` a `currentCoordinatorUrl + "/task/receive"`.
  5. Si el envío falla: usar `handleCoordinatorError` (409 → seguir al nuevo líder) y **encolar** el resultado en `pendingResults`. `flushPendingResults()` lo reenvía tras el siguiente pulso exitoso (máx. 3 intentos por resultado, luego se descarta con log).
- Toda excepción durante la ejecución produce `status: "error"` con texto legible, nunca un crash.
- Registrar cada paso con `logActivity`.

### 4.4 Comportamiento del Coordinador

- Estructura en memoria: `tasks = {}` con
  `{ taskId, type, payload, worker, status, createdAt, assignedAt, completedAt, result, error }`
  y `status ∈ "assigned" | "ok" | "error" | "timeout"`.
- **Solo el líder asigna.** `POST /api/tasks` usa `onlyLeader`.
- Selección de worker:
  - Si la UI indica `worker`, verificar que esté online **y** tenga la capacidad; si no, 400.
  - Si no se indica, elegir entre los workers online con la capacidad el que tenga **menos tareas `assigned`** (desempate por orden de registro).
  - Si no hay candidato → 409/422 `{ error: "Ningún worker online con la capacidad requerida" }`.
- Generar `taskId` como `task-<timestamp>-<rand>` si la UI no lo trae.
- Timeout de tarea: `TASK_TIMEOUT_MS` (por defecto 30000). Si vence → `status: "timeout"`. Si el worker cae (offline), sus tareas `assigned` pasan a `error`.
- `POST /task/receive` actualiza la tarea, la registra con `recordMessage({type:"system_event", ...})` y responde `{ok:true}`.
- Todas las llamadas a workers con `timeout: PULSE_TIMEOUT_MS` (8000) y el header ngrok (ya es global en `axios.defaults`).

### 4.5 Capacidades (grupo G8)

#### 4.5.1 Asignación por persona (obligatoria, no intercambiable)

| Persona | Capacidad que implementa | `WORKER_CAPABILITIES` | URL ngrok del día del parcial |
|---|---|---|---|
| Castillo Jiménez Juan Diego | 5 · `vector_distance` | `vector_distance` | `https://elinor-globose-jonah.ngrok-free.dev` |
| Becerra Morales Paula Selene | 6 · `http_latency` | `http_latency` | `https://yodel-posting-resubmit.ngrok-free.dev` |

- El worker que corre detrás de `https://elinor-globose-jonah.ngrok-free.dev` (Juan Diego) **únicamente** debe aceptar y ejecutar `vector_distance`. Cualquier `task-assign` de tipo `http_latency` que le llegue debe responder `400` (capacidad no soportada), igual que a cualquier otro tipo no declarado en su `CAPABILITIES`.
- El worker que corre detrás de `https://yodel-posting-resubmit.ngrok-free.dev` (Paula) **únicamente** debe aceptar y ejecutar `http_latency`, con el mismo rechazo `400` para `vector_distance` u otros tipos.
- Estas URLs son el `PUBLIC_URL`/segundo argumento (`argv[3]`) con el que cada quien arranca su propio worker (`node index.js {PUERTO} {URL_NGROK}`, sección 2), no algo que se valide por código contra un dominio fijo: la restricción real es que cada `.env` solo trae su propia `WORKER_CAPABILITIES`. No hace falta (ni conviene) hardcodear las URLs de ngrok en el código: son efímeras y cambian cada vez que se reinicia ngrok si no se usa un dominio fijo/reservado.

#### 5 · `vector_distance` — Juan Diego
- Payload: `{ "a": [x1, y1], "b": [x2, y2] }`
- Resultado: `{ "distance": <número> }` — distancia euclidiana `Math.hypot(x2-x1, y2-y1)`.
- Validación: `a` y `b` deben ser arreglos de **exactamente 2** números finitos; si no → `status: "error"`.
- Ejemplo: `a:[0,0], b:[3,4]` → `{"distance": 5}`.

#### 6 · `http_latency` — Paula
- Payload: `{ "url": "https://..." }`
- Resultado: `{ "ms": <entero> }` — milisegundos redondeados (`Math.round`) medidos con `performance.now()` alrededor de un `axios.get` (timeout 8000 ms, `validateStatus: () => true` para medir aunque el código HTTP sea 4xx/5xx).
- Validación: la URL debe empezar por `http://` o `https://`; si no → `status: "error"`.
- Fallo de red/timeout → `status: "error"` con el motivo.
- Ejemplo: `{"ms": 36}`.

---

## 5. Tiempos del sistema

### 5.1 Constantes (definir arriba de cada `index.js`)

| Constante | Valor | Reemplaza |
|---|---|---|
| `PING_INTERVAL_MS` | 2000 | 2500 (coordinador) |
| `PING_TIMEOUT_MS` | 5000 | `timeout: 1500` en `sendPeerPings` |
| `PING_RETRIES` | 3 | `failCount >= 2` |
| `PULSE_INTERVAL_MS` | 3000 | 5000 (worker) |
| `PULSE_TIMEOUT_MS` | 8000 | 3000 (worker `apiClient`) y 10000 (limpieza de `servers` en coordinador) |
| `PULSE_RETRIES` | 3 | (nuevo) |

### 5.2 Interpretación (confirmar con el docente si hay duda)
- **Ping** = coordinador↔coordinador. Un peer se da por caído tras 3 fallos consecutivos, cada uno con timeout de 5 s.
- **Pulse** = worker→líder. Cada pulso tiene timeout de 8 s. El worker considera caído al líder (`findNewLeader`) tras **3 fallos consecutivos** (contador nuevo `pulseFailCount`; en 409 el comportamiento actual se mantiene inmediato).
- El líder marca un worker `offline` tras `PULSE_RETRIES × PULSE_INTERVAL_MS` = 9 s sin pulso (reemplaza los 10 s actuales del `setInterval` de timeout y el `TIMEOUT_MS` de `/servers`).
- Ajustar el watchdog del líder (5 s) para que sea coherente: `PING_RETRIES × PING_INTERVAL_MS + margen`.

---

## 6. UI web

### 6.1 Estado actual de `public/` (revisado)

- `public/index.html` = **Centro de Control Unificado** (JS inline, Tailwind CDN). Es la UI principal que sirve `express.static` en `/`. Consulta `GET /election/state` de cada coordinador conocido, `GET /servers` para los workers, y ya soporta: plantar semilla, matar/eliminar/limpiar coordinadores, enviar mensaje con reintento ante 409, matar workers.
- `public/app.js` = dashboard **NexusCluster** (versión anterior: usa `/api/stats`, `/api/messages`, umbral de 15 s, no maneja 409). Su HTML no fue entregado. **Se considera legado: no se toca.** (Si ese HTML también se sirve, avisar para revisarlo.)

Toda la sección 6 aplica a `index.html`.

### 6.2 Cambios obligatorios sobre código existente de `index.html`

| # | Dónde | Cambio | Motivo |
|---|---|---|---|
| U1 | `renderTopology()`, bloque `portMap` (`portKey = parsed.port \|\| "80"`) | Clave de deduplicación: si el host es `localhost`/`127.0.0.1` → usar el puerto (comportamiento actual); si no → usar `parsed.host`. | Las URLs ngrok no tienen puerto: todas caerían en la clave `"80"` y **todos los coordinadores ngrok se fusionarían en una sola tarjeta**. |
| U3 | Tabla de workers (`<thead>` y `renderWorkers`) | Añadir columna **Capacidades** (badges con `w.capabilities`) y subir los `colspan="5"` a `6`. | Requisito: mostrar capacidades. |
| U4 | `fetch` del formulario de mensajes (`dispatchMessageWithRetry`) | Añadir header `"ngrok-skip-browser-warning": "true"`. | Sin él, ngrok gratis puede devolver la página intermedia en vez de JSON. |
| U5 | Texto estático "Threshold timeout: 15 seg" y fallback `elapsedSeconds <= 10` | Cambiar a 9 s (solo etiqueta/fallback; el estado real ya viene de `w.isOnline`). | Coherencia con la sección 5. |
| U6 | `addLog` (switch de tipos) | Añadir el caso `"TASK"` (badge ámbar/violeta). | Log de tareas. |

### 6.3 Código nuevo en `index.html` (aditivo)

**A. Panel "Tareas" (nueva `<section>` entre el grid de workers/mensajes y la consola de eventos).**

1. **Enviar tarea** (formulario):
   - `select` de tipo: `vector_distance`, `http_latency` (o la unión de capacidades de los workers online).
   - Campos dinámicos según tipo: `a` (x,y) y `b` (x,y) para `vector_distance`; `url` para `http_latency`. Previsualizar el JSON del payload.
   - `select` de worker: "Automático" + workers **online que tengan esa capacidad** (filtrar con `w.capabilities`).
   - Botón → `POST {activeLeaderUrl}/api/tasks` con body `{ type, payload, worker? }` y header ngrok. Reutilizar el patrón de `dispatchMessageWithRetry`: ante **409** seguir a `data.leader`; ante **503** reintentar tras ~1 s (máx. 3). Mostrar feedback con `showFeedback` / `addLog("TASK", …)`.
2. **Tabla de tareas**: columnas `taskId · tipo · worker · estado · resultado/error · duración`. Estados con badge: `assigned` (ámbar), `ok` (verde), `error` (rojo), `timeout` (gris). Resultado como JSON compacto.
3. **Polling**: dentro de `syncCluster()` (misma cadencia de 2 s), llamar `fetchTasks(activeLeaderUrl)` → `GET /api/tasks`. Si no hay líder, mostrar "Sin líder: no hay tareas disponibles".
   - Respuesta esperada: `{ "total": n, "tasks": [ {taskId, type, payload, worker, status, createdAt, assignedAt, completedAt, result, error} ] }` (más recientes primero).
4. Registrar en la consola de eventos los **cambios de estado** (comparando con el poll anterior) con `addLog("TASK", ...)`.

**B. Nada más.** No modificar semilla, elección, kill, ni el envío de mensajes salvo U4.

### 6.4 Requisito del parcial vs. estado real
- "Mostrar backups": hoy **no existe el concepto de backup** en el sistema (solo líder/seguidor). No inventarlo en la UI hasta que se implemente replicación; los seguidores se muestran como `SEGUIDOR`.
- Las tareas viven solo en la memoria del líder. Si el líder cae, la UI mostrará la lista vacía del nuevo líder (limitación aceptada hasta implementar sync/replicación).
- Auto-descubrimiento de puertos 3000–3003 en `syncCluster`: solo tiene sentido en localhost. Bajo ngrok falla en silencio (600 ms por puerto, cada ciclo). Es inofensivo; **no tocar** salvo que moleste.

### 6.5 Worker (HTML embebido en `index.js`)
Mantener todo lo actual; añadir capacidades, campo de lag (`POST /task/config`) y tabla de tareas (recibida, ejecutando, enviada, error), según W5.

---

## 7. Lo que NO se debe tocar

- Lógica Bully: `startElection`, `becomeLeader`, `setLeader`, `/election/*` (salvo C2 y C3).
- Gossip y `deadPeers`.
- `onlyLeader` y sus códigos 409/503.
- `findNewLeader`, `handleCoordinatorError`, `registerWithLeader` (salvo W2).
- CORS y header `ngrok-skip-browser-warning`.
- Rutas de compatibilidad (`/pulse`, `/disconnect`, `/unregister`, `/kill*`, `/update-parent-url`, `/config`).
- `public/app.js` (dashboard NexusCluster legado) y cualquier lógica de `index.html` no listada en 6.2/6.3.

---

## 8. Criterios de aceptación

1. `node index.js 4000 https://x.ngrok.dev` levanta el worker con `NAME` desde `.env` (`WORKER_ID`).
2. `node index.js A 3000` / `node index.js B 3001 http://localhost:3000` siguen levantando el coordinador exactamente como hoy (ID de letra, sin `.env` para el ID).
3. Con 3 coordinadores (`A`, `B`, `C`), el de letra mayor gana la elección (comparación de cadenas, C2); al matarlo, se reelige en pocos segundos y los workers se reconectan solos.
4. `GET {worker}/task/capabilities` devuelve `["vector_distance","http_latency"]` y el líder las muestra en `/servers`.
5. Tarea `vector_distance` con `[0,0]`,`[3,4]` → `status: ok`, `distance: 5`, tras el lag configurado.
6. Tarea `http_latency` con URL válida → `ms` entero; con URL inválida → `status: error`.
7. Asignar a un worker sin la capacidad → rechazo claro, sin efectos secundarios.
8. Matar al líder durante una tarea: el worker conserva el resultado y lo entrega al nuevo líder.
9. Enviar una tarea a un follower → 409 con `leader`; la UI redirige o informa.

### Pruebas rápidas (curl)
```bash
# Capacidades
curl http://localhost:4000/task/capabilities

# Asignar directo al worker (simula al coordinador)
curl -X POST http://localhost:4000/task/assign -H "Content-Type: application/json" \
  -d '{"type":"task-assign","data":{"taskId":"task-1","type":"vector_distance","payload":{"a":[0,0],"b":[3,4]}}}'

# Crear tarea desde el líder
curl -X POST http://localhost:3000/api/tasks -H "Content-Type: application/json" \
  -d '{"type":"http_latency","payload":{"url":"https://example.com"}}'

# Cambiar lag del worker
curl -X POST http://localhost:4000/task/config -H "Content-Type: application/json" -d '{"delayMs":5000}'
```

---

## 9. Orden de implementación sugerido

1. Constantes de tiempo (C4, C5, W4) y nuevo parseo de argumentos del worker (W1) + C2/C3 (documentar, sin tocar código).
2. Worker: `CAPABILITIES`, `GET /task/capabilities`, ejecutores de las 2 capacidades, `POST /task/assign` con lag, `pendingResults`.
3. Coordinador: `tasks`, `POST /task/receive`, `POST /api/tasks`, `GET /api/tasks`, timeouts de tarea, C6/C7.
4. UIs (worker primero, coordinador después).
5. Pruebas de la sección 8 con varios nodos y con compañeros.