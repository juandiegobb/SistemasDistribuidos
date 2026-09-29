const path = require("path");
const fs = require("fs");
const express = require("express");
const axios = require("axios");

// Cargar variables de entorno desde archivo .env si existe
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, "utf-8");
    envContent.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const idx = trimmed.indexOf("=");
        if (idx !== -1) {
          const key = trimmed.substring(0, idx).trim();
          const val = trimmed.substring(idx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    });
  } catch (err) {
    console.error("Error cargando .env:", err.message);
  }
}

const app = express();
app.use(express.json());

// Habilitar CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, ngrok-skip-browser-warning");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// ==========================================================================
// CONSTANTES DE TIEMPO DEL SISTEMA (sección 5 AGENTS.md) — W4
// ==========================================================================
const PULSE_INTERVAL_MS = 3000;  // Intervalo de pulso worker → coordinador
const PULSE_TIMEOUT_MS = 8000;  // Timeout de pulso (y de llamadas a tareas)
const PULSE_RETRIES = 3;     // Fallos consecutivos antes de buscar nuevo líder

// W1: Parseo de argumentos flexible (local y túneles ngrok)
let PORT, NAME, MY_WORKER_URL, currentCoordinatorUrl;

PORT = Number(process.argv[2]) || 4000;

if (process.argv[3] !== undefined && String(process.argv[3]).startsWith('http')) {
  // Modo: node miniServer.js {PUERTO} {URL_WORKER_NGROK} [URL_COORD]
  MY_WORKER_URL = process.argv[3];
  NAME = process.env.WORKER_ID || `worker-${PORT}`;
  currentCoordinatorUrl = process.argv[4] || process.env.PUBLIC_URL || 'http://localhost:3000';
} else {
  // Modo: node miniServer.js {PUERTO} {NOMBRE} [URL_WORKER_NGROK] [URL_COORD]
  NAME = process.argv[3] || process.env.WORKER_ID || `worker-${PORT}`;

  if (process.argv[5]) {
    // 4 parámetros pasados: node miniServer.js 4000 worker-juan https://worker.ngrok.dev https://coord.ngrok.dev
    MY_WORKER_URL = process.argv[4];
    currentCoordinatorUrl = process.argv[5];
  } else if (process.argv[4]) {
    const arg4 = process.argv[4].trim();
    if (arg4.includes('ngrok') || arg4.includes('loca.lt')) {
      MY_WORKER_URL = arg4;
      currentCoordinatorUrl = process.env.PUBLIC_URL || 'http://localhost:3000';
    } else {
      currentCoordinatorUrl = arg4;
      MY_WORKER_URL = process.env.WORKER_URL || `http://localhost:${PORT}`;
    }
  } else {
    MY_WORKER_URL = process.env.WORKER_URL || `http://localhost:${PORT}`;
    currentCoordinatorUrl = process.env.PUBLIC_URL || 'http://localhost:3000';
  }
}

// Configuración de Axios con cabeceras ngrok
const apiClient = axios.create({
  timeout: PULSE_TIMEOUT_MS,  // W4: actualizado de 3000 a PULSE_TIMEOUT_MS (8000)
  headers: {
    "ngrok-skip-browser-warning": "true",
    "Content-Type": "application/json",
  },
});

// Mapa de coordinadores conocidos: { [url]: { status: "no se" | "LIDER" | "no manda" | "no responde", label: string } }
let knownCoordinators = {
  [currentCoordinatorUrl]: { status: "no se", label: currentCoordinatorUrl },
};

// Historial de actividad
let activityLogs = [];
let isSearchingLeader = false;
let lastPulseTime = null;
let pulseInterval = null;

// ==========================================================================
// CAPACIDADES ASIGNADAS AL GRUPO G8 (Parcial de Sistemas Distribuidos)
// 5. vector_distance (Juan Diego): distancia euclidiana 2D
// 6. http_latency (Paula Selene): latencia HTTP en ms
// ==========================================================================

function resolveCapabilities() {
  if (process.env.CAPABILITY) {
    return [process.env.CAPABILITY.trim()];
  }
  if (process.env.CAPABILITIES) {
    return process.env.CAPABILITIES.split(',').map(c => c.trim()).filter(Boolean);
  }
  const name = String(NAME || '').toLowerCase();
  const workerUrl = String(MY_WORKER_URL || '').toLowerCase();

  // Paula (Capacidad 6: http_latency)
  if (name.includes('paula') || name.includes('selene') || workerUrl.includes('yodel-posting-resubmit')) {
    return ['http_latency'];
  }
  // Juan Diego (Capacidad 5: vector_distance)
  return ['vector_distance'];
}

const CAPABILITIES = resolveCapabilities();

// Lag configurable en milisegundos (modificable en caliente con POST /task/config)
let TASK_DELAY_MS = Number(process.env.TASK_DELAY_MS) || 3000;

// Cola de tareas recibidas: { taskId, type, payload, status, result, error, receivedAt, completedAt }
let tasks = [];

// Resultados pendientes de entregar al coordinador (por caída del líder durante la tarea)
let pendingResults = [];

// 5. vector_distance (Juan Diego): distancia euclidiana entre dos vectores 2D
// Payload: { "a": [0,0], "b": [3,4] } -> Resultado: { "distance": 5 }
function executeVectorDistance(payload) {
  const { a, b } = payload || {};
  if (
    !Array.isArray(a) || a.length !== 2 || !a.every(n => isFinite(n)) ||
    !Array.isArray(b) || b.length !== 2 || !b.every(n => isFinite(n))
  ) {
    throw new Error('Payload inválido: a y b deben ser arreglos de exactamente 2 números finitos');
  }
  return { distance: Math.hypot(b[0] - a[0], b[1] - a[1]) };
}

// 6. http_latency (Paula): latencia de una URL en milisegundos
// Payload: { "url": "https://..." } -> Resultado: { "ms": 36 }
async function executeHttpLatency(payload) {
  const { url } = payload || {};
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    throw new Error('Payload inválido: url debe empezar por http:// o https://');
  }
  const start = require('perf_hooks').performance.now();
  try {
    await axios.get(url, { timeout: 8000, validateStatus: () => true });
  } catch (e) {
    throw new Error(`Error de red/timeout al medir ${url}: ${e.message}`);
  }
  return { ms: Math.round(require('perf_hooks').performance.now() - start) };
}

// Enviar resultado de tarea al coordinador líder
async function sendTaskResult(taskId, resultBody) {
  if (!currentCoordinatorUrl) {
    logActivity(`Tarea ${taskId}: sin coordinador, encolando resultado para reintento`);
    pendingResults.push({ taskId, body: resultBody, attempts: 0 });
    return;
  }
  try {
    await apiClient.post(`${currentCoordinatorUrl}/task/receive`, resultBody);
    logActivity(`Tarea ${taskId}: resultado entregado al coordinador`);
  } catch (err) {
    if (err.response && err.response.status === 409) {
      // Camino rápido: seguir al nuevo líder
      handleCoordinatorError(err, currentCoordinatorUrl, 'task-result');
      pendingResults.push({ taskId, body: resultBody, attempts: 0 });
    } else {
      logActivity(`Tarea ${taskId}: no se pudo entregar resultado, encolando`);
      pendingResults.push({ taskId, body: resultBody, attempts: 0 });
    }
  }
}

// Reenviar resultados pendientes tras pulso exitoso (W3)
async function flushPendingResults() {
  if (pendingResults.length === 0 || !currentCoordinatorUrl) return;
  const toFlush = [...pendingResults];
  pendingResults = [];
  for (const entry of toFlush) {
    try {
      await apiClient.post(`${currentCoordinatorUrl}/task/receive`, entry.body);
      logActivity(`Resultado pendiente de tarea ${entry.taskId} entregado exitosamente`);
    } catch (err) {
      entry.attempts++;
      if (entry.attempts < 3) {
        pendingResults.push(entry); // reintentar en el siguiente pulso
      } else {
        logActivity(`Tarea ${entry.taskId}: descartando resultado tras 3 intentos fallidos`);
      }
    }
  }
}

function formatTime(d = new Date()) {
  return d.toLocaleTimeString("es-CO", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function logActivity(message) {
  const timeStr = formatTime();
  const entry = `${timeStr} ${message}`;
  console.log(`[${NAME}:${PORT}] ${entry}`);
  activityLogs.unshift(entry);
  if (activityLogs.length > 200) activityLogs.pop();
}

// Incorporar coordinadores descubiertos
function addKnownCoordinators(urls, defaultStatus = "no se") {
  if (!Array.isArray(urls)) return;
  urls.forEach((u) => {
    const rawUrl = typeof u === "string" ? u : u?.url;
    if (rawUrl && typeof rawUrl === "string") {
      const normalized = rawUrl.trim();
      if (!knownCoordinators[normalized]) {
        const label = (typeof u === "object" && u?.id) ? `[${u.id}] ${normalized}` : normalized;
        knownCoordinators[normalized] = { status: defaultStatus, label };
        logActivity(`Me entero de que existe ${normalized}`);
      }
    }
  });
}

// Registrar worker en el líder
async function registerWithLeader(coordUrl) {
  if (!coordUrl) return false;
  try {
    const res = await apiClient.post(`${coordUrl}/register`, {
      name: NAME,
      url: MY_WORKER_URL,
      capabilities: CAPABILITIES,  // W2: publicar capacidades al registrarse
    });
    if (res.status === 200) {
      currentCoordinatorUrl = coordUrl;
      // Marcar este coordinador como el único LIDER activo
      Object.keys(knownCoordinators).forEach((k) => {
        if (knownCoordinators[k].status === "LIDER") knownCoordinators[k].status = "no manda";
      });
      knownCoordinators[coordUrl] = { status: "LIDER", label: coordUrl };
      logActivity(`Registrado exitosamente con el líder ${coordUrl}`);
      restartPulseCycle();
      return true;
    }
  } catch (err) {
    handleCoordinatorError(err, coordUrl, "register");
    return false;
  }
}

// W4: Contador de fallos consecutivos de pulso (se reinicia en éxito o en 409)
let pulseFailCount = 0;

// Enviar pulso/heartbeat periódico (intenta /pulse/:name y fallback a /heartbeat/:name)
async function sendPulse() {
  if (!currentCoordinatorUrl || isSearchingLeader) return;

  try {
    let res;
    try {
      res = await apiClient.post(`${currentCoordinatorUrl}/pulse/${encodeURIComponent(NAME)}`, {});
    } catch (pulseErr) {
      if (pulseErr.response && pulseErr.response.status === 404) {
        // Fallback a /heartbeat/:name si el coordinador usa esa ruta
        res = await apiClient.post(`${currentCoordinatorUrl}/heartbeat/${encodeURIComponent(NAME)}`, {});
      } else {
        throw pulseErr;
      }
    }

    if (res && (res.status === 200 || res.status === 204)) {
      pulseFailCount = 0;  // W4: reiniciar contador en pulso exitoso
      lastPulseTime = new Date().toISOString();
      if (res.data?.peers) {
        addKnownCoordinators(res.data.peers);
      }
      Object.keys(knownCoordinators).forEach((k) => {
        if (k !== currentCoordinatorUrl && knownCoordinators[k].status === "LIDER") {
          knownCoordinators[k].status = "no manda";
        }
      });
      knownCoordinators[currentCoordinatorUrl] = { status: "LIDER", label: currentCoordinatorUrl };
      logActivity(`Pulso aceptado por ${currentCoordinatorUrl}. Estoy en linea.`);
      flushPendingResults();  // W3: reenviar resultados pendientes tras pulso exitoso
    }
  } catch (err) {
    // W4: 409 → redirección inmediata al líder real; otros errores acumulan hasta PULSE_RETRIES
    if (err.response && err.response.status === 409) {
      pulseFailCount = 0;
      handleCoordinatorError(err, currentCoordinatorUrl, "heartbeat");
    } else {
      pulseFailCount++;
      logActivity(`Fallo de pulso ${pulseFailCount}/${PULSE_RETRIES}: ${err.message || 'sin respuesta'}`);
      if (pulseFailCount >= PULSE_RETRIES) {
        pulseFailCount = 0;
        handleCoordinatorError(err, currentCoordinatorUrl, "heartbeat");
      }
    }
  }
}

// Manejador de errores adaptativo (Camino Rápido HTTP 409 vs Camino Lento Timeout/503)
function handleCoordinatorError(err, coordUrl, actionType = "pulse") {
  // Camino Rápido: El coordinador responde 409 y nos da la URL del líder
  if (err.response && err.response.status === 409) {
    const data = err.response.data || {};
    const leader = data.leader;
    const peers = data.peers;

    if (peers) addKnownCoordinators(peers);
    if (knownCoordinators[coordUrl]) {
      knownCoordinators[coordUrl].status = "no manda";
    }

    if (leader) {
      if (!knownCoordinators[leader]) {
        knownCoordinators[leader] = { status: "no se", label: leader };
      }
      logActivity(`${coordUrl} no es el lider, me manda a ${leader}`);
      currentCoordinatorUrl = leader;
      registerWithLeader(leader);
      return;
    }
  }

  // Camino Lento: Fallo de red, timeout o HTTP 503 (elección en progreso)
  if (knownCoordinators[coordUrl]) {
    knownCoordinators[coordUrl].status = "no responde";
  }
  logActivity("El coordinador ha dejado de responder. Me quedo sin coordinador.");
  currentCoordinatorUrl = null;

  if (!isSearchingLeader) {
    findNewLeader();
  }
}

// Algoritmo de Búsqueda de Líder (Fase 5)
async function findNewLeader() {
  if (isSearchingLeader) return;
  isSearchingLeader = true;

  const urls = Object.keys(knownCoordinators);
  logActivity(`Nadie me manda. Voy a preguntar a los ${urls.length} coordinadores que conozco.`);

  let foundNewLeaderUrl = null;

  for (const coordUrl of urls) {
    try {
      logActivity(`Pregunto a ${coordUrl}...`);
      const res = await apiClient.get(`${coordUrl}/election/state`, { timeout: 1500 });
      const data = res.data || {};

      if (data.peers) addKnownCoordinators(data.peers);

      if (data.role === "leader" || data.leader === data.id) {
        knownCoordinators[coordUrl].status = "LIDER";
        logActivity(`${coordUrl} es el lider. Me registro allá.`);
        foundNewLeaderUrl = coordUrl;
        break;
      } else if (data.leaderUrl || (data.leader && data.leader.startsWith("http"))) {
        const designated = data.leaderUrl || data.leader;
        knownCoordinators[coordUrl].status = "no manda";
        if (designated) {
          logActivity(`${coordUrl} no manda, dice que manda ${designated}. Voy alli.`);
          foundNewLeaderUrl = designated;
          break;
        }
      } else {
        knownCoordinators[coordUrl].status = "no manda";
      }
    } catch (err) {
      if (knownCoordinators[coordUrl]) {
        knownCoordinators[coordUrl].status = "no responde";
      }
      logActivity(`Pregunto a ${coordUrl}... no responde.`);
    }
  }

  if (foundNewLeaderUrl) {
    isSearchingLeader = false;
    currentCoordinatorUrl = foundNewLeaderUrl;
    await registerWithLeader(foundNewLeaderUrl);
  } else {
    logActivity("Nadie sabe quien manda todavia. Reintento en 2s.");
    isSearchingLeader = false;
    setTimeout(findNewLeader, 2000);
  }
}

function restartPulseCycle() {
  if (pulseInterval) clearInterval(pulseInterval);
  pulseInterval = setInterval(sendPulse, PULSE_INTERVAL_MS);  // W4: PULSE_INTERVAL_MS = 3000
}

// ==========================================================================
// RUTAS DE LA API Y UTILITARIOS
// ==========================================================================

// Endpoint para el estado del worker (usado por la UI en tiempo real)
app.get("/worker-state", (req, res) => {
  res.json({
    name: NAME,
    port: PORT,
    url: MY_WORKER_URL,
    currentCoordinatorUrl,
    knownCoordinators,
    activityLogs,
    lastPulseTime,
    isSearchingLeader,
    capabilities: CAPABILITIES,   // W5
    taskDelayMs: TASK_DELAY_MS,   // W5
    tasks,                         // W5
  });
});

// Enviar mensaje al coordinador actual
app.post("/send-message", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "El campo 'message' es obligatorio" });
  }

  if (!currentCoordinatorUrl) {
    return res.status(503).json({ error: "No hay coordinador líder conectado" });
  }

  try {
    const response = await apiClient.post(`${currentCoordinatorUrl}/send-message/${NAME}`, {
      message,
    });
    logActivity(`Mensaje enviado al líder ${currentCoordinatorUrl}: "${message}"`);
    res.json({ status: "success", serverResponse: response.data });
  } catch (error) {
    handleCoordinatorError(error, currentCoordinatorUrl, "send-message");
    res.status(500).json({ error: "No se pudo entregar el mensaje al coordinador" });
  }
});

// Cambiar URL de coordinador manualmente
const updateParentUrl = async (req, res) => {
  const { newParentUrl, url } = req.body;
  const targetUrl = newParentUrl || url;

  if (!targetUrl) {
    return res.status(400).json({ error: "El campo 'newParentUrl' o 'url' es obligatorio" });
  }

  logActivity(`Cambio manual de coordinador a ${targetUrl}`);
  currentCoordinatorUrl = targetUrl;
  if (!knownCoordinators[targetUrl]) {
    knownCoordinators[targetUrl] = { status: "no se", label: targetUrl };
  }

  await registerWithLeader(targetUrl);
  res.json({ message: `Coordinador actualizado a ${currentCoordinatorUrl}` });
};

app.put("/config", updateParentUrl);
// ==========================================================================
// ENDPOINTS DE TAREAS (sección 4 AGENTS.md — código nuevo)
// ==========================================================================

// GET /task/capabilities — devuelve capacidades del worker
app.get('/task/capabilities', (req, res) => {
  res.json({ worker: NAME, capabilities: CAPABILITIES });
});

// POST /task/config — cambiar el lag en caliente
app.post('/task/config', (req, res) => {
  const { delayMs } = req.body || {};
  if (typeof delayMs !== 'number' || delayMs < 0) {
    return res.status(400).json({ ok: false, error: 'delayMs debe ser un número >= 0' });
  }
  TASK_DELAY_MS = delayMs;
  logActivity(`Lag de tarea actualizado a ${TASK_DELAY_MS} ms`);
  res.json({ ok: true, taskDelayMs: TASK_DELAY_MS });
});

// POST /task/assign — el coordinador asigna una tarea a este worker
app.post('/task/assign', async (req, res) => {
  const body = req.body || {};
  // Soporta formato estándar {"type": "task-assign", "data": {...}} o formato plano {...}
  const isWrapped = body.type === 'task-assign' && body.data;
  const taskData = isWrapped ? body.data : (body.data || body);

  const taskId = taskData.taskId || taskData.id || `task-${Date.now()}`;
  const taskType = taskData.type || taskData.taskType;
  const payload = taskData.payload !== undefined ? taskData.payload : taskData;

  // Validar campos mínimos
  if (!taskType) {
    return res.status(400).json({ ok: false, error: 'Payload inválido: se requiere type' });
  }

  // Validar capacidad
  if (!CAPABILITIES.includes(taskType)) {
    logActivity(`Tarea ${taskId}: capacidad no soportada: ${taskType}`);
    return res.status(400).json({ ok: false, error: `Capacidad no soportada: ${taskType}` });
  }

  // Responder 202 de inmediato (no bloquear la petición)
  res.status(202).json({ ok: true, taskId });
  logActivity(`Tarea ${taskId} (${taskType}) recibida. Ejecutando con lag=${TASK_DELAY_MS} ms`);

  // Registrar en la lista local
  const taskEntry = { taskId, type: taskType, payload, status: 'ejecutando', receivedAt: Date.now(), completedAt: null, result: null, error: null };
  tasks.unshift(taskEntry);
  if (tasks.length > 100) tasks.pop();

  // Ejecutar la tarea primero y luego esperar el lag restante
  const execStart = Date.now();
  let resultBody;
  try {
    let result;
    if (taskType === 'vector_distance') {
      result = executeVectorDistance(payload);
    } else if (taskType === 'http_latency') {
      result = await executeHttpLatency(payload);
    } else {
      throw new Error(`Capacidad no soportada por el grupo G8: ${taskType}`);
    }

    const elapsed = Date.now() - execStart;
    const remaining = Math.max(0, TASK_DELAY_MS - elapsed);
    if (remaining > 0) {
      logActivity(`Tarea ${taskId}: ejecución lista en ${elapsed} ms, esperando lag restante ${remaining} ms`);
      await new Promise(resolve => setTimeout(resolve, remaining));
    }
    taskEntry.status = 'ok';
    taskEntry.result = result;
    taskEntry.completedAt = Date.now();
    resultBody = { type: 'task-result', data: { taskId, status: 'ok', result } };
    logActivity(`Tarea ${taskId} completada: ${JSON.stringify(result)}`);
  } catch (err) {
    taskEntry.status = 'error';
    taskEntry.error = err.message;
    taskEntry.completedAt = Date.now();
    resultBody = { type: 'task-result', data: { taskId, status: 'error', error: err.message } };
    logActivity(`Tarea ${taskId} error: ${err.message}`);
  }

  // Enviar resultado al coordinador líder
  await sendTaskResult(taskId, resultBody);
});

app.post("/config", updateParentUrl);
app.post("/update-parent-url", updateParentUrl);

// Notificar al coordinador sobre la desconexión
async function notifyDisconnect() {
  if (!currentCoordinatorUrl || !NAME) return;
  try {
    await apiClient.post(`${currentCoordinatorUrl}/disconnect/${encodeURIComponent(NAME)}`, { name: NAME }, { timeout: 1000 });
  } catch (e) {
    // Si falla el endpoint dedicado, intentar compatibilidad con query o body
    try {
      await apiClient.post(`${currentCoordinatorUrl}/disconnect`, { name: NAME }, { timeout: 800 });
    } catch (err) { }
  }
}

// Shutdown
app.post("/shutdown", async (req, res) => {
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
    logActivity("Pulsos detenidos por shutdown. Notificando desconexión...");
  }
  await notifyDisconnect();
  res.json({ message: `${NAME} desconectado y fuera de línea` });
});

// Kill
const handleKill = async (req, res) => {
  logActivity("Apagando servidor worker...");
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
  }
  await notifyDisconnect();
  res.json({ message: `${NAME} detenido` });
  setTimeout(() => process.exit(0), 300);
};

app.post("/kill", handleKill);
app.get("/kill", handleKill);
app.post("/kill-server", handleKill);

// Interceptar terminación del proceso (Ctrl+C en consola o kill de proceso)
let isCleaningUp = false;
async function handleProcessExit(signal) {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log(`\n[${NAME}] Señal ${signal} recibida. Notificando desconexión al coordinador...`);
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
  }
  try {
    await notifyDisconnect();
  } catch (e) { }
  process.exit(0);
}

process.on("SIGINT", () => handleProcessExit("SIGINT"));
process.on("SIGTERM", () => handleProcessExit("SIGTERM"));

// ==========================================================================
// INTERFAZ VISUAL WEB (GET /)
// ==========================================================================
app.get("/", (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Worker: ${NAME} (Puerto ${PORT})</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b1120;
      --card-bg: #151e32;
      --card-border: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --badge-leader: #10b981;
      --badge-nomanda: #3b82f6;
      --badge-noresponde: #ef4444;
      --badge-nose: #64748b;
      --terminal-bg: #070c18;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 24px 16px;
      display: flex;
      justify-content: center;
    }

    .container {
      width: 100%;
      max-width: 900px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* HEADER */
    .header {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    }

    .worker-info h1 {
      font-size: 26px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 12px;
      color: #fff;
    }

    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--badge-leader);
      display: inline-block;
      box-shadow: 0 0 12px var(--badge-leader);
      animation: pulse-dot 2s infinite;
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(1.15); }
    }

    .worker-meta {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 6px;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }

    .worker-meta span strong {
      color: var(--primary);
    }

    .last-pulse-box {
      background: rgba(56, 189, 248, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 10px;
      padding: 10px 16px;
      text-align: right;
      font-size: 13px;
    }

    .last-pulse-box .time {
      font-size: 15px;
      font-weight: 600;
      color: var(--primary);
      font-family: 'JetBrains Mono', monospace;
    }

    /* SECCIONES CARD */
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }

    .card-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* LISTA DE COORDINADORES */
    .coord-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 12px;
    }

    .coord-item {
      background: #0d1526;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: all 0.2s ease;
    }

    .coord-item:hover {
      border-color: #334155;
      transform: translateY(-1px);
    }

    .coord-url {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 600;
      color: #e2e8f0;
    }

    .badge {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .badge-LIDER { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-nomanda { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); }
    .badge-noresponde { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .badge-nose { background: rgba(100, 116, 139, 0.2); color: #94a3b8; border: 1px solid rgba(100, 116, 139, 0.4); }

    /* TERMINAL LOGS */
    .terminal {
      background: var(--terminal-bg);
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 16px;
      height: 280px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12.5px;
      line-height: 1.6;
      color: #cbd5e1;
      display: flex;
      flex-direction: column-reverse;
    }

    .log-entry {
      padding: 2px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      word-break: break-all;
    }

    .log-time {
      color: #64748b;
      margin-right: 8px;
    }

    .log-msg-lead { color: #34d399; }
    .log-msg-warn { color: #fbbf24; }
    .log-msg-err { color: #f87171; }

    /* MENSAJE FORM */
    .msg-form {
      display: flex;
      gap: 10px;
    }

    .msg-input {
      flex: 1;
      background: #0d1526;
      border: 1px solid #243247;
      border-radius: 10px;
      padding: 12px 16px;
      color: #fff;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }

    .msg-input:focus {
      border-color: var(--primary);
    }

    .btn {
      background: var(--primary);
      color: #04101e;
      font-weight: 700;
      font-size: 14px;
      border: none;
      border-radius: 10px;
      padding: 0 24px;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
    }

    .btn:hover {
      background: var(--primary-hover);
    }

    .btn:active {
      transform: scale(0.98);
    }

    /* COLLAPSIBLE MANUAL */
    details {
      border: 1px dashed #223049;
      border-radius: 10px;
      padding: 12px 16px;
      font-size: 13px;
    }

    details summary {
      color: var(--text-muted);
      cursor: pointer;
      font-weight: 600;
    }

    .manual-box {
      margin-top: 12px;
      display: flex;
      gap: 10px;
    }

    /* W5: Capacidades y tabla de tareas */
    .cap-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .cap-badge {
      background: rgba(56,189,248,0.15); color: #38bdf8;
      border: 1px solid rgba(56,189,248,0.35); border-radius: 6px;
      padding: 3px 10px; font-size: 12px; font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
    }
    .lag-row { display: flex; gap: 10px; align-items: center; }
    .lag-input {
      width: 120px; background: #0d1526; border: 1px solid #243247;
      border-radius: 8px; padding: 8px 12px; color: #fff;
      font-size: 14px; font-family: inherit; outline: none;
    }
    .task-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .task-table th {
      text-align: left; padding: 8px 10px; color: var(--text-muted);
      border-bottom: 1px solid #1e293b; font-weight: 600; font-size: 11px; text-transform: uppercase;
    }
    .task-table td { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); word-break: break-all; }
    .badge-ok    { background: rgba(16,185,129,0.2); color: #34d399; border: 1px solid rgba(16,185,129,0.4); border-radius:5px; padding:2px 7px; font-size:11px; font-weight:700; }
    .badge-error { background: rgba(239,68,68,0.2);  color: #f87171; border: 1px solid rgba(239,68,68,0.4);  border-radius:5px; padding:2px 7px; font-size:11px; font-weight:700; }
    .badge-ejecutando { background: rgba(251,191,36,0.2); color: #fbbf24; border: 1px solid rgba(251,191,36,0.4); border-radius:5px; padding:2px 7px; font-size:11px; font-weight:700; }
  </style>
</head>
<body>
  <div class="container">
    <!-- HEADER -->
    <div class="header">
      <div class="worker-info">
        <h1><span class="status-dot" id="statusDot"></span> ${NAME}</h1>
        <div class="worker-meta">
          <span>Puerto: <strong>${PORT}</strong></span>
          <span>Coordinador Líder: <strong id="leadUrl">${currentCoordinatorUrl || 'Buscando...'}</strong></span>
        </div>
        <!-- W5: Capacidades -->
        <div class="cap-list" id="capList">
          ${CAPABILITIES.map(c => `<span class="cap-badge">${c}</span>`).join('')}
        </div>
      </div>
      <div class="last-pulse-box">
        <div style="color: var(--text-muted); margin-bottom: 2px;">Último pulso:</div>
        <div class="time" id="lastPulse">Esperando pulso...</div>
      </div>
    </div>

    <!-- COORDINADORES QUE CONOZCO -->
    <div class="card">
      <div class="card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
        COORDINADORES QUE CONOZCO
      </div>
      <div class="coord-list" id="coordList">
        <!-- Renderizado dinámico -->
      </div>
    </div>

    <!-- QUE ESTOY HACIENDO (TERMINAL) -->
    <div class="card">
      <div class="card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        QUE ESTOY HACIENDO
      </div>
      <div class="terminal" id="terminal">
        <!-- Logs dinámicos -->
      </div>
    </div>

    <!-- MENSAJE -->
    <div class="card">
      <div class="card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        MENSAJE
      </div>
      <form class="msg-form" id="msgForm">
        <input type="text" id="msgInput" class="msg-input" placeholder="Escribe un mensaje para enviar al líder..." required>
        <button type="submit" class="btn">Send</button>
      </form>
    </div>

    <!-- W5: LAG DE TAREA -->
    <div class="card">
      <div class="card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        LAG DE TAREA
      </div>
      <div class="lag-row">
        <span style="font-size:13px;color:var(--text-muted);">Delay actual: <strong id="lagVal">${TASK_DELAY_MS} ms</strong></span>
        <input type="number" id="lagInput" class="lag-input" min="0" step="100" placeholder="ms" value="${TASK_DELAY_MS}">
        <button type="button" class="btn" id="lagBtn" style="padding:0 18px;font-size:13px;">Aplicar</button>
      </div>
    </div>

    <!-- W5: TABLA DE TAREAS -->
    <div class="card">
      <div class="card-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
        TAREAS RECIBIDAS
      </div>
      <div style="overflow-x:auto;">
        <table class="task-table">
          <thead><tr><th>ID</th><th>Tipo</th><th>Estado</th><th>Resultado / Error</th></tr></thead>
          <tbody id="taskTableBody"><tr><td colspan="4" style="color:var(--text-muted);text-align:center;">Sin tareas</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- APAGAR / MATAR WORKER -->
    <div class="card" style="border: 1px solid rgba(239, 68, 68, 0.35); background: rgba(239, 68, 68, 0.05);">
      <div class="card-title" style="color: #f87171; margin-bottom: 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
        CONTROL DE APAGADO
      </div>
      <div style="display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
        <span style="font-size: 13px; color: var(--text-muted);">Apagar este proceso y notificar al coordinador:</span>
        <button type="button" id="killWorkerBtn" class="btn" style="background: #ef4444; color: #fff; padding: 8px 18px; font-size: 13px;">Matar Worker</button>
      </div>
    </div>

    <!-- CAMBIAR DE COORDINADOR A MANO -->
    <details>
      <summary>Cambiar de coordinador a mano</summary>
      <div class="manual-box">
        <input type="text" id="manualUrl" class="msg-input" placeholder="http://localhost:3000" value="${currentCoordinatorUrl}">
        <button type="button" class="btn" id="manualBtn">Cambiar</button>
      </div>
    </details>
  </div>

  <script>
    async function updateState() {
      try {
        const res = await fetch('/worker-state');
        if (!res.ok) return;
        const state = await res.json();

        // 1. Header
        document.getElementById('leadUrl').textContent = state.currentCoordinatorUrl || 'Buscando líder...';
        if (state.lastPulseTime) {
          const d = new Date(state.lastPulseTime);
          document.getElementById('lastPulse').textContent = d.toLocaleTimeString('es-CO');
        }

        const statusDot = document.getElementById('statusDot');
        if (state.isSearchingLeader) {
          statusDot.style.background = '#fbbf24';
          statusDot.style.boxShadow = '0 0 12px #fbbf24';
        } else if (state.currentCoordinatorUrl) {
          statusDot.style.background = '#10b981';
          statusDot.style.boxShadow = '0 0 12px #10b981';
        } else {
          statusDot.style.background = '#ef4444';
          statusDot.style.boxShadow = '0 0 12px #ef4444';
        }

        // 2. Coordinadores
        const coordList = document.getElementById('coordList');
        coordList.innerHTML = '';
        const entries = Object.entries(state.knownCoordinators || {});
        entries.forEach(([url, item]) => {
          const div = document.createElement('div');
          div.className = 'coord-item';
          const badgeClass = 'badge-' + (item.status || 'nose').replace(/\s+/g, '');
          div.innerHTML = \`
            <span class="coord-url">\${url}</span>
            <span class="badge \${badgeClass}">\${item.status}</span>
          \`;
          coordList.appendChild(div);
        });

        // 3. Terminal Logs
        const term = document.getElementById('terminal');
        term.innerHTML = '';
        (state.activityLogs || []).forEach(log => {
          const line = document.createElement('div');
          line.className = 'log-entry';
          let colorClass = '';
          if (log.includes('LIDER') || log.includes('aceptado') || log.includes('exitosamente')) colorClass = 'log-msg-lead';
          else if (log.includes('no es el lider') || log.includes('no manda') || log.includes('Reintento')) colorClass = 'log-msg-warn';
          else if (log.includes('ha dejado de responder') || log.includes('no responde')) colorClass = 'log-msg-err';

          line.innerHTML = \`<span class="\${colorClass}">\${log}</span>\`;
          term.appendChild(line);
        });

        // 4. W5: Lag actual
        const lagValEl = document.getElementById('lagVal');
        if (lagValEl) lagValEl.textContent = (state.taskDelayMs ?? '?') + ' ms';

        // 5. W5: Tabla de tareas
        const tbody = document.getElementById('taskTableBody');
        if (tbody) {
          const taskArr = Object.values(state.tasks || {}).sort((a,b) => (b.receivedAt||0)-(a.receivedAt||0));
          if (taskArr.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;">Sin tareas</td></tr>';
          } else {
            tbody.innerHTML = taskArr.map(t => {
              const badgeClass = t.status === 'ok' ? 'badge-ok' : t.status === 'error' ? 'badge-error' : 'badge-ejecutando';
              const resText = t.result ? JSON.stringify(t.result) : (t.error || '');
              return \`<tr>
                <td style="font-family:monospace;font-size:11px;">\${t.taskId}</td>
                <td>\${t.type}</td>
                <td><span class="\${badgeClass}">\${t.status}</span></td>
                <td style="color:#94a3b8;">\${resText}</td>
              </tr>\`;
            }).join('');
          }
        }
      } catch (err) {
        console.error("Error actualizando UI:", err);
      }
    }

    setInterval(updateState, 1200);
    updateState();

    // Enviar Mensaje
    document.getElementById('msgForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('msgInput');
      const message = input.value.trim();
      if (!message) return;

      try {
        const res = await fetch('/send-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (res.ok) {
          input.value = '';
          updateState();
        } else {
          alert('Error enviando mensaje: ' + (data.error || 'Error'));
        }
      } catch (e) {
        alert('Error de conexión');
      }
    });

    // Cambio manual de coordinador
    document.getElementById('manualBtn').addEventListener('click', async () => {
      const url = document.getElementById('manualUrl').value.trim();
      if (!url) return;
      try {
        await fetch('/update-parent-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newParentUrl: url })
        });
        updateState();
      } catch (e) {
        alert('Error cambiando coordinador');
      }
    });

    // Matar este worker
    document.getElementById('killWorkerBtn').addEventListener('click', async () => {
      if (!confirm('¿Seguro que deseas apagar este worker?')) return;
      try {
        await fetch('/kill', { method: 'POST' });
        alert('Worker apagado correctamente.');
        document.body.innerHTML = '<div style="font-family: monospace; color: #f87171; text-align: center; padding-top: 20vh; font-size: 20px;">✓ Worker detenido y desconectado del clúster.</div>';
      } catch (e) {
        alert('Worker detenido.');
      }
    });

    // W5: Cambiar lag de tarea
    document.getElementById('lagBtn').addEventListener('click', async () => {
      const ms = parseInt(document.getElementById('lagInput').value, 10);
      if (isNaN(ms) || ms < 0) { alert('Ingresa un número >= 0'); return; }
      try {
        const r = await fetch('/task/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delayMs: ms })
        });
        const d = await r.json();
        if (d.ok) { document.getElementById('lagVal').textContent = d.taskDelayMs + ' ms'; }
      } catch(e) { alert('Error cambiando lag'); }
    });
  </script>
</body>
</html>`;
  res.send(html);
});

// ==========================================================================
// ARRANQUE DEL SERVIDOR
// ==========================================================================
app.listen(PORT, async () => {
  logActivity(`Worker ${NAME} corriendo en ${MY_WORKER_URL}`);
  logActivity(`Intentando conectar al coordinador inicial: ${currentCoordinatorUrl}`);

  // Intentar registro inicial
  const ok = await registerWithLeader(currentCoordinatorUrl);
  if (!ok && !isSearchingLeader) {
    findNewLeader();
  }
});
