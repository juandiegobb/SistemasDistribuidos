const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = Number(process.argv[2]) || 4000;
const NAME = process.argv[3] || "worker-1";
let MY_WORKER_URL = `http://localhost:${PORT}`;

// Configuración de Axios con cabeceras ngrok
const apiClient = axios.create({
  timeout: 3000,
  headers: {
    "ngrok-skip-browser-warning": "true",
    "Content-Type": "application/json",
  },
});

// Coordinador inicial (por defecto o por parámetro process.argv[4])
let currentCoordinatorUrl = process.argv[4] || "http://localhost:3000";

// Mapa de coordinadores conocidos: { [url]: { status: "no se" | "LIDER" | "no manda" | "no responde", label: string } }
let knownCoordinators = {
  [currentCoordinatorUrl]: { status: "no se", label: currentCoordinatorUrl },
};

// Historial de actividad
let activityLogs = [];
let isSearchingLeader = false;
let lastPulseTime = null;
let pulseInterval = null;

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
    if (u && typeof u === "string") {
      const normalized = u.trim();
      if (!knownCoordinators[normalized]) {
        knownCoordinators[normalized] = { status: defaultStatus, label: normalized };
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

// Enviar pulso/heartbeat periódico
async function sendPulse() {
  if (!currentCoordinatorUrl || isSearchingLeader) return;

  try {
    const res = await apiClient.post(`${currentCoordinatorUrl}/heartbeat/${NAME}`, {});
    if (res.status === 200) {
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
    }
  } catch (err) {
    handleCoordinatorError(err, currentCoordinatorUrl, "heartbeat");
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
  pulseInterval = setInterval(sendPulse, 5000);
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
app.post("/config", updateParentUrl);
app.post("/update-parent-url", updateParentUrl);

// Shutdown
app.post("/shutdown", (req, res) => {
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
    logActivity("Pulsos detenidos por shutdown");
  }
  res.json({ message: `${NAME} dejó de enviar pulsos` });
});

// Kill
const handleKill = (req, res) => {
  logActivity("Apagando servidor worker...");
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
  }
  res.json({ message: `${NAME} detenido` });
  setTimeout(() => process.exit(0), 300);
};

app.post("/kill", handleKill);
app.get("/kill", handleKill);
app.post("/kill-server", handleKill);

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
        const state = await res.data ? res.data : await res.json();

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
