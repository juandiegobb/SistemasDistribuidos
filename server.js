const path = require("path");
const fs = require("fs");
const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
// Servir archivos estáticos del dashboard visual
app.use(express.static(path.join(__dirname, "public")));

// Identidad y Estado de Coordinador
const NODE_ID = process.argv[2] || "A";
const PORT = Number(process.argv[3]) || 3000;
const SEED_URL = process.argv[4] || null;
const MY_URL = `http://localhost:${PORT}`;

// Variables de estado del nodo
let role = "follower"; // "leader" | "candidate" | "follower"
let currentLeader = null;
let currentTerm = 0;
let electionInProgress = false;
let peers = {};

// Función Helper de Logging Centralizada para Coordinadores
function logCoord(message) {
  const ts = new Date().toISOString();
  console.log(`[${NODE_ID}:${PORT}] [${ts}] [INFO] [COORDINATOR] ${message}`);
}

// Preset de nodos del cluster LAN si no se especifican otros
const PRESET_LAN_NODES = [
  { id: "A", port: 3000, url: "http://localhost:3000" },
  { id: "B", port: 3001, url: "http://localhost:3001" },
  { id: "C", port: 3002, url: "http://localhost:3002" },
];

PRESET_LAN_NODES.forEach((preset) => {
  if (preset.url !== MY_URL && preset.port !== PORT) {
    if (!peers[preset.url]) {
      peers[preset.url] = {
        id: preset.id,
        url: preset.url,
        lastSeen: 0,
      };
    }
  }
});

// Si se proporcionó SEED_URL y es distinta a MY_URL, agregarla a la lista de peers inicial
if (SEED_URL && SEED_URL !== MY_URL) {
  if (!peers[SEED_URL]) {
    peers[SEED_URL] = {
      id: null,
      url: SEED_URL,
      lastSeen: 0,
    };
  }
}

const startTime = Date.now();

// Almacenamiento en memoria
let servers = {};
let serverProcesses = {};
let nextPort = 4000;

// Historial general de mensajes y por servidor
let messagesByServer = {};
let allMessages = [];
let heartbeatHistory = [];

// Helper para registrar mensajes en la lista global
function recordMessage({ sender, message, target = null, type = "received" }) {
  const msgObj = {
    id: "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
    sender: sender || "Desconocido",
    target: target || "Middleware",
    message,
    type,
    timestamp: new Date().toISOString(),
    timeMs: Date.now(),
  };

  allMessages.unshift(msgObj); // Insertar al inicio para mostrar los más recientes
  if (allMessages.length > 500) {
    allMessages.pop();
  }

  return msgObj;
}

// Ruta raíz - Si no se solicita HTML explícito o se consulta por API, se puede ver status
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    server: "Middleware Juan Diego",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeServers: Object.keys(servers).length,
  });
});

// Registrar servidor
app.post("/register", (req, res) => {
  const { name, url } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: "Name and URL required" });
  }

  const isNew = !servers[name];

  servers[name] = {
    name,
    url,
    registeredAt: servers[name]?.registeredAt || Date.now(),
    lastHeartbeat: Date.now(),
    heartbeatCount: (servers[name]?.heartbeatCount || 0) + 1,
    status: "active",
  };

  let clientIp = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip || req.socket?.remoteAddress || "127.0.0.1";
  if (clientIp.includes("::ffff:")) {
    clientIp = clientIp.replace("::ffff:", "");
  }
  if (clientIp === "::1") {
    clientIp = "127.0.0.1";
  }

  logCoord(`Server registered: [${name}] at ${url} from ${clientIp}`);

  recordMessage({
    sender: name,
    message: `Servidor registrado en la red [URL: ${url}]`,
    target: "Middleware",
    type: "system_event",
  });

  res.json({
    message: "server registered successfully",
    server: servers[name],
  });
});

// HeartBeat
app.post("/heartbeat/:name", (req, res) => {
  const { name } = req.params;

  if (servers[name]) {
    servers[name].lastHeartbeat = Date.now();
    servers[name].heartbeatCount = (servers[name].heartbeatCount || 0) + 1;
    servers[name].status = "active";

    // Registrar en log ligero de heartbeats para métricas
    heartbeatHistory.unshift({
      server: name,
      timestamp: Date.now(),
    });
    if (heartbeatHistory.length > 100) heartbeatHistory.pop();

    return res.json({
      message: "Hearbeat received",
      server: name,
      timestamp: Date.now(),
    });
  }

  res.status(400).json({ error: "Server not found" });
});

// Actualizar dinámicamente la URL registrada de un hijo
app.put("/servers/:name/url", (req, res) => {
  const { name } = req.params;
  const { url } = req.body;

  if (!servers[name]) {
    return res.status(404).json({ error: "server not found" });
  }

  if (!url) {
    return res.status(400).json({ error: "El campo 'url' es obligatorio" });
  }

  servers[name].url = url;
  res.json({ message: "URL actualizada", server: servers[name] });
});

// Eliminar / Matar Servidor
app.post("/kill-server/:name", async (req, res) => {
  const { name } = req.params;

  if (!servers[name] && !serverProcesses[name]) {
    return res.status(400).json({ error: "server not found" });
  }

  // Notificar al proceso del miniServer para que se apague
  if (servers[name]?.url) {
    try {
      fetch(`${servers[name].url}/kill`, { method: "POST" }).catch(() => { });
    } catch (e) { }
  }

  if (serverProcesses[name]?.process) {
    try {
      serverProcesses[name].process.kill();
    } catch (e) {
      console.error(`Error killing process for ${name}:`, e.message);
    }
    delete serverProcesses[name];
  }

  delete servers[name];

  recordMessage({
    sender: "Middleware",
    message: `Servidor [${name}] ha sido detenido/eliminado`,
    target: name,
    type: "system_alert",
  });

  console.log(`Server ${name} is killed`);
  res.json({ message: `${name} killed` });
});

// Obtener Servidores activos (compatible con frontend y scripts)
app.get("/servers", (req, res) => {
  const now = Date.now();
  const serverList = Object.values(servers).map((s) => ({
    ...s,
    ageSeconds: Math.floor((now - s.lastHeartbeat) / 1000),
    elapsedSeconds: Math.floor((now - s.lastHeartbeat) / 1000),
    isOnline: s.status === "active" && now - s.lastHeartbeat <= 15000,
    isHealthy: s.status === "active" && now - s.lastHeartbeat <= 15000,
  }));
  res.json(serverList);
});

// Mensaje general recibido por /messages
app.post("/messages", (req, res) => {
  const { sender, message } = req.body;
  console.log(`[MENSAJE RECIBIDO de ${sender}]: ${message}`);

  if (!message) {
    return res.status(400).json({ error: "El campo 'message' es obligatorio" });
  }

  const recorded = recordMessage({
    sender: sender || "Anónimo",
    message,
    target: "Middleware",
    type: "received",
  });

  res.json({ status: "success", info: "Mensaje recibido", data: recorded });
});

// POST /send-message/:name -> Recibir/Guardar mensaje para un servidor específico
app.post("/send-message/:name", (req, res) => {
  const { name } = req.params;
  const { message, sender } = req.body;

  if (!message) {
    return res.status(400).json({ error: "El campo 'message' es obligatorio" });
  }

  if (!messagesByServer[name]) {
    messagesByServer[name] = [];
  }

  const msgEntry = {
    id: "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
    sender: sender || name,
    message,
    timestamp: new Date().toISOString(),
    timeMs: Date.now(),
  };

  messagesByServer[name].push(msgEntry);

  const recorded = recordMessage({
    sender: sender || name,
    message,
    target: name,
    type: "node_message",
  });

  console.log(`[MENSAJE para ${name}]: ${message}`);
  res.json({
    status: "success",
    info: `Mensaje guardado para ${name}`,
    data: recorded,
  });
});

// GET /send-message/:name -> Ver mensajes de un servidor específico
app.get("/send-message/:name", (req, res) => {
  const { name } = req.params;
  const messages = messagesByServer[name] || [];
  res.json({ server: name, messages });
});

// ==========================================
// NUEVAS RUTAS API PARA EL DASHBOARD VISUAL
// ==========================================

// GET /api/messages -> Obtener todos los mensajes con soporte de filtros
app.get("/api/messages", (req, res) => {
  const { server, search, limit = 100 } = req.query;
  let filtered = [...allMessages];

  if (server && server !== "all") {
    filtered = filtered.filter(
      (m) =>
        m.sender.toLowerCase() === server.toLowerCase() ||
        m.target?.toLowerCase() === server.toLowerCase(),
    );
  }

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (m) =>
        m.message.toLowerCase().includes(q) ||
        m.sender.toLowerCase().includes(q),
    );
  }

  res.json({
    total: filtered.length,
    messages: filtered.slice(0, parseInt(limit, 10)),
  });
});

// DELETE /api/messages -> Limpiar historial de mensajes
app.delete("/api/messages", (req, res) => {
  allMessages = [];
  messagesByServer = {};
  res.json({ status: "success", message: "Historial de mensajes vaciado" });
});

// GET /api/stats -> Métricas generales para el dashboard
app.get("/api/stats", (req, res) => {
  const now = Date.now();
  const serverValues = Object.values(servers);
  const activeCount = serverValues.filter(
    (s) => s.status === "active" && now - s.lastHeartbeat <= 15000,
  ).length;

  res.json({
    uptimeSeconds: Math.floor((now - startTime) / 1000),
    totalServers: serverValues.length,
    activeServers: activeCount,
    inactiveServers: serverValues.length - activeCount,
    totalMessages: allMessages.length,
    timeoutThreshold: 15000,
    serverList: serverValues.map((s) => ({
      name: s.name,
      url: s.url,
      status: s.status,
      lastHeartbeat: s.lastHeartbeat,
      elapsedSeconds: Math.floor((now - s.lastHeartbeat) / 1000),
      isOnline: s.status === "active" && now - s.lastHeartbeat <= 15000,
      heartbeatCount: s.heartbeatCount || 1,
    })),
  });
});

// POST /api/broadcast -> Enviar un mensaje a todos los servidores o simular
app.post("/api/send-custom", (req, res) => {
  const { sender, target, message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "El mensaje es requerido" });
  }

  const recorded = recordMessage({
    sender: sender || "Dashboard Admin",
    target: target || "Broadcast",
    message,
    type: target && target !== "Broadcast" ? "outgoing" : "broadcast",
  });

  res.json({ status: "success", data: recorded });
});

// ==========================================================================
// PROTOCOLO DE DESCUBRIMIENTO DE COORDINADORES Y ELECCIÓN (BULLY)
// ==========================================================================

// Comparar prioridad de identificadores para algoritmo Bully ('C' > 'B' > 'A')
function isHigherPriority(id1, id2) {
  if (!id2) return true;
  if (!id1) return false;
  const num1 = Number(id1);
  const num2 = Number(id2);
  if (!isNaN(num1) && !isNaN(num2)) {
    return num1 > num2;
  }
  return String(id1).localeCompare(String(id2)) > 0;
}

// Determinar si una URL pertenece al líder actual
function isPeerLeader(peerUrl) {
  if (!currentLeader) return false;
  if (peers[peerUrl]?.id === currentLeader) return true;
  const preset = PRESET_LAN_NODES.find((p) => p.id === currentLeader);
  if (preset && peerUrl.includes(`:${preset.port}`)) return true;
  return false;
}

// Obtener la dirección URL del líder actual
function getLeaderUrl() {
  if (!currentLeader) return null;
  if (currentLeader === NODE_ID) return MY_URL;
  const peer = Object.values(peers).find((p) => p.id === currentLeader);
  if (peer && peer.url) return peer.url;
  const preset = PRESET_LAN_NODES.find((p) => p.id === currentLeader);
  if (preset) return preset.url;
  return null;
}

let lastLoggedLeader = null;
let lastLoggedTerm = -1;

// Establecer líder y emitir log de cambio únicamente tras elección o caída de líder
function setLeader(newLeader, term, algo = "bully", options = {}) {
  const prevLeader = currentLeader;
  currentLeader = newLeader;
  if (term !== undefined) {
    currentTerm = term;
  }
  role = currentLeader === NODE_ID ? "leader" : "follower";
  electionInProgress = false;

  // Solo mostrar en consola:
  // 1. Si este nodo es quien se proclama líder (newLeader === NODE_ID)
  // 2. O si proviene de un mensaje de victoria de elección (options.fromElection === true)
  // 3. O si hubo una re-elección tras caída (prevLeader !== null && prevLeader !== newLeader)
  const isSelfLeader = newLeader === NODE_ID;
  const isReelection = prevLeader !== null && prevLeader !== newLeader;
  const shouldLog = isSelfLeader || isReelection || options.fromElection === true;

  if (shouldLog) {
    if (lastLoggedLeader !== currentLeader || lastLoggedTerm !== currentTerm) {
      lastLoggedLeader = currentLeader;
      lastLoggedTerm = currentTerm;
      logCoord(`Lider ahora: ${currentLeader} (term ${currentTerm}, algo ${algo})`);
    }
  } else {
    // Si solo estamos reconociendo pasivamente al líder inicial existente al arrancar, no spameamos consola
    lastLoggedLeader = currentLeader;
    lastLoggedTerm = currentTerm;
  }
}

// Obtener estado serializable del nodo y su cluster
function getElectionState() {
  const now = Date.now();
  const leaderUrl = getLeaderUrl();
  return {
    nodeId: NODE_ID,
    url: MY_URL,
    role,
    currentLeader,
    leaderUrl,
    currentTerm,
    electionInProgress,
    peers: Object.values(peers).map((p) => ({
      ...p,
      elapsedSeconds: Math.floor((now - (p.lastSeen || 0)) / 1000),
      isOnline: (p.lastSeen || 0) > 0 && now - p.lastSeen <= 15000,
    })),
  };
}

// Endpoint POST /election/ping -> Recepción de ping de descubrimiento entre coordinadores
app.post("/election/ping", (req, res) => {
  const { from, peers: incomingPeers } = req.body;

  if (!from || !from.url) {
    return res.status(400).json({ error: "Payload inválido: se requiere 'from.url'" });
  }

  const senderUrl = from.url;
  const senderId = from.id || "Desconocido";

  // Actualizar o registrar el peer emisor si es distinto al nodo local
  if (senderUrl !== MY_URL) {
    const isNew = !peers[senderUrl];
    peers[senderUrl] = {
      id: senderId,
      url: senderUrl,
      lastSeen: Date.now(),
    };

    if (isNew) {
      logCoord(`Nuevo peer descubierto: ${senderId} (${senderUrl})`);
      recordMessage({
        sender: senderId,
        message: `Nuevo coordinador detectado en la red [${senderUrl}]`,
        target: NODE_ID,
        type: "system_event",
      });
    }
  }

  // Descubrir nuevos peers propagados en la lista (gossip / chisme)
  if (Array.isArray(incomingPeers)) {
    incomingPeers.forEach((peerUrl) => {
      if (peerUrl && peerUrl !== MY_URL && !peers[peerUrl]) {
        peers[peerUrl] = {
          id: null,
          url: peerUrl,
          lastSeen: 0,
        };
        logCoord(`Peer aprendido por propagación: ${peerUrl}`);
      }
    });
  }

  // Responder con acuse de recibo, identidad, rol, líder y término actual
  res.json({
    ok: true,
    from: { id: NODE_ID, url: MY_URL },
    role,
    currentLeader,
    currentTerm,
    peers: Object.keys(peers),
  });
});

// Endpoint POST /election/elect -> Mensaje de elección Bully recibido de nodo inferior
app.post("/election/elect", (req, res) => {
  const { from, term } = req.body;
  if (!from || !from.url) {
    return res.status(400).json({ error: "Payload inválido" });
  }

  if (term !== undefined && term > currentTerm) {
    currentTerm = term;
  }

  if (from.url !== MY_URL) {
    peers[from.url] = {
      id: from.id || null,
      url: from.url,
      lastSeen: Date.now(),
    };
  }

  // Responder inmediatamente 'OK' al nodo de menor jerarquía
  res.json({ ok: true, from: { id: NODE_ID, url: MY_URL } });

  // Si este nodo tiene mayor prioridad que el emisor, tomar el control de la elección
  if (isHigherPriority(NODE_ID, from.id)) {
    if (!electionInProgress) {
      startElection("challenged_by_lower_node");
    }
  }
});

// Endpoint POST /election/coordinator -> Anuncio de nuevo líder
app.post("/election/coordinator", (req, res) => {
  const { leader, url, term } = req.body;
  if (!leader) {
    return res.status(400).json({ error: "Campo 'leader' requerido" });
  }

  if (url && url !== MY_URL) {
    peers[url] = {
      id: leader,
      url: url,
      lastSeen: Date.now(),
    };
  }

  setLeader(leader, term !== undefined ? term : currentTerm, "bully", { fromElection: true });
  res.json({ ok: true });
});

// Endpoint POST /kill -> Apagar este coordinador (simulación de caída para pruebas)
app.post("/kill", (req, res) => {
  res.json({ message: `Coordinador ${NODE_ID} apagándose` });
  setTimeout(() => process.exit(0), 100);
});

// GET /election/status -> Consultar estado actual del coordinador y sus peers
app.get("/election/status", (req, res) => {
  res.json(getElectionState());
});

// GET /election/state -> Consultar estado del coordinador y lista de peers
app.get("/election/state", (req, res) => {
  const leaderUrl = getLeaderUrl();
  res.status(200).json({
    id: NODE_ID,
    url: MY_URL,
    role: role,
    leader: currentLeader,
    leaderUrl: leaderUrl,
    peers: Object.keys(peers),
  });
});

// Proclamarse líder del cluster y notificar a todos los pares
async function becomeLeader() {
  setLeader(NODE_ID, currentTerm, "bully");

  const peerUrls = Object.keys(peers);
  await Promise.all(
    peerUrls.map(async (url) => {
      try {
        await axios.post(
          `${url}/election/coordinator`,
          {
            leader: NODE_ID,
            url: MY_URL,
            term: currentTerm,
          },
          { timeout: 1500 }
        );
      } catch (err) {
        // Peer temporalmente inalcanzable
      }
    })
  );
}

// Iniciar algoritmo de elección Bully
async function startElection(reason = "normal") {
  if (electionInProgress) return;
  electionInProgress = true;
  role = "candidate";

  if (reason !== "initial_election") {
    currentTerm++;
  }

  // Buscar peers con ID de mayor jerarquía que NODE_ID
  const higherPeers = Object.values(peers).filter((p) => {
    return p.id && isHigherPriority(p.id, NODE_ID);
  });

  // Si no hay ningún nodo superior, este nodo es el ganador inmediato
  if (higherPeers.length === 0) {
    await becomeLeader();
    return;
  }

  let higherResponded = false;

  await Promise.all(
    higherPeers.map(async (peer) => {
      try {
        const res = await axios.post(
          `${peer.url}/election/elect`,
          {
            from: { id: NODE_ID, url: MY_URL },
            term: currentTerm,
          },
          { timeout: 1500 }
        );
        if (res.data && res.data.ok) {
          higherResponded = true;
          peer.lastSeen = Date.now();
        }
      } catch (err) {
        // El nodo superior no respondió (caído)
      }
    })
  );

  if (higherResponded) {
    // Un nodo superior está activo y continuará la elección; esperamos mensaje coordinador
    setTimeout(() => {
      if (electionInProgress && role !== "leader") {
        electionInProgress = false;
        startElection("higher_timeout");
      }
    }, 4000);
  } else {
    // Ningún nodo superior respondió: este nodo gana la elección Bully
    await becomeLeader();
  }
}

// Verificación inicial de líder al arrancar el nodo
async function checkInitialLeader() {
  if (role === "leader") return;

  const peerList = Object.values(peers);
  let foundLeader = null;
  let foundLeaderTerm = 0;

  for (const peer of peerList) {
    try {
      const res = await axios.get(`${peer.url}/election/status`, { timeout: 800 });
      if (res.data) {
        peer.lastSeen = Date.now();
        if (res.data.nodeId) peer.id = res.data.nodeId;
        if (res.data.role === "leader" && res.data.currentLeader) {
          foundLeader = res.data.currentLeader;
          foundLeaderTerm = res.data.currentTerm || 0;
          break;
        }
      }
    } catch (e) {
      // Peer no responde aún
    }
  }

  if (foundLeader) {
    if (isHigherPriority(NODE_ID, foundLeader)) {
      startElection("bully_superior_node");
    } else {
      setLeader(foundLeader, foundLeaderTerm, "bully", { fromElection: false });
    }
  } else {
    // Si no hay líder activo detectado:
    // Solo el nodo de mayor jerarquía del cluster (ej. C) se proclama líder inicial
    const higherPeers = Object.values(peers).filter((p) => p.id && isHigherPriority(p.id, NODE_ID));
    if (higherPeers.length === 0) {
      startElection("initial_election");
    }
  }
}

// Rutina periódica de intercambio de pings entre coordinadores
const PING_INTERVAL_MS = 2500;

async function sendPeerPings() {
  const peerUrls = Object.keys(peers);
  if (peerUrls.length === 0) return;

  const payload = {
    from: { id: NODE_ID, url: MY_URL },
    peers: peerUrls,
  };

  for (const peerUrl of peerUrls) {
    try {
      const response = await axios.post(`${peerUrl}/election/ping`, payload, {
        timeout: 1500,
      });

      if (peers[peerUrl]) {
        peers[peerUrl].lastSeen = Date.now();
        if (response.data?.from?.id) {
          peers[peerUrl].id = response.data.from.id;
        }
      }

      // Si el peer es el líder y tiene un término válido
      if (response.data?.role === "leader" && response.data?.currentLeader) {
        if (currentLeader !== response.data.currentLeader && !electionInProgress) {
          setLeader(
            response.data.currentLeader,
            response.data.currentTerm !== undefined ? response.data.currentTerm : currentTerm,
            "bully",
            { fromElection: false }
          );
        }
      }

      // Incorporar nuevos pares reportados en la respuesta
      if (Array.isArray(response.data?.peers)) {
        response.data.peers.forEach((discoveredUrl) => {
          if (discoveredUrl && discoveredUrl !== MY_URL && !peers[discoveredUrl]) {
            peers[discoveredUrl] = {
              id: null,
              url: discoveredUrl,
              lastSeen: 0,
            };
            logCoord(`Nuevo peer descubierto vía respuesta de ${peerUrl}: ${discoveredUrl}`);
          }
        });
      }
    } catch (err) {
      // Peer temporalmente inalcanzable. Comprobar si era el líder actual
      if (currentLeader && isPeerLeader(peerUrl)) {
        if (!electionInProgress && role !== "leader") {
          logCoord("Lider caído detectado. Iniciando eleccion Bully...");
          currentLeader = null;
          startElection("leader_ping_failed");
        }
      }
    }
  }
}

// Iniciar rutina periódica de pings
const peerPingInterval = setInterval(sendPeerPings, PING_INTERVAL_MS);

// Watchdog de salud de líder: detecta si no se reciben señales del líder en más de 5s
setInterval(() => {
  if (role === "leader" || electionInProgress) return;
  if (!currentLeader) return;

  const leaderPeer = Object.values(peers).find((p) => p.id === currentLeader);
  if (leaderPeer && (leaderPeer.lastSeen || 0) > 0) {
    if (Date.now() - leaderPeer.lastSeen > 5000) {
      logCoord("Lider caído detectado. Iniciando eleccion Bully...");
      currentLeader = null;
      startElection("leader_timeout");
    }
  }
}, 2000);

// Timeout check periódico de servidores
setInterval(() => {
  const now = Date.now();
  const timeout = 15000;

  Object.keys(servers).forEach((name) => {
    if (now - servers[name].lastHeartbeat > timeout) {
      if (servers[name].status !== "offline") {
        console.log(`Server ${name} timed out. Marcado como offline.`);
        servers[name].status = "offline";

        recordMessage({
          sender: "Sistema",
          message: `Servidor [${name}] desconectado por inactividad (>15s sin pulso)`,
          target: name,
          type: "system_alert",
        });
      }

      if (serverProcesses[name]) {
        try {
          serverProcesses[name].process.kill();
        } catch (e) { }
        delete serverProcesses[name];
      }
      // Se eliminó el delete servers[name] para mantener el nodo persistente como offline
    }
  });
}, 10000);

app.listen(PORT, () => {
  const totalNodes = Math.max(3, Object.keys(peers).length + 1);
  const quorum = Math.floor(totalNodes / 2) + 1;
  logCoord(`Motor de eleccion arrancado (bully, preset lan, ${totalNodes} nodos, quorum ${quorum})`);

  setTimeout(() => {
    checkInitialLeader();
  }, 1000);
});
