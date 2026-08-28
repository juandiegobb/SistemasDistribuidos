const path = require("path");
const fs = require("fs");
const express = require("express");

const app = express();

app.use(express.json());
// Servir archivos estáticos del dashboard visual
app.use(express.static(path.join(__dirname, "public")));

const PORT = 3000;
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

  console.log(`Server registered succesfully: ${name} (${url})`);

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

// Eliminar / Matar Servidor
app.post("/kill-server/:name", (req, res) => {
  const { name } = req.params;

  if (!servers[name] && !serverProcesses[name]) {
    return res.status(400).json({ error: "server not found" });
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
    isHealthy: now - s.lastHeartbeat <= 15000,
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
    (s) => now - s.lastHeartbeat <= 15000,
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
      lastHeartbeat: s.lastHeartbeat,
      elapsedSeconds: Math.floor((now - s.lastHeartbeat) / 1000),
      isOnline: now - s.lastHeartbeat <= 15000,
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

// Timeout check periódico de servidores
setInterval(() => {
  const now = Date.now();
  const timeout = 15000;

  Object.keys(servers).forEach((name) => {
    if (now - servers[name].lastHeartbeat > timeout) {
      console.log(`Server ${name} timed out. Killing...`);

      recordMessage({
        sender: "Sistema",
        message: `Servidor [${name}] desconectado por inactividad (>15s sin pulso)`,
        target: name,
        type: "system_alert",
      });

      if (serverProcesses[name]) {
        try {
          serverProcesses[name].process.kill();
        } catch (e) {}
        delete serverProcesses[name];
      }
      delete servers[name];
    }
  });
}, 10000);

app.listen(PORT, () => {
  console.log(`Middleware corriendo en http://localhost:${PORT}`);
  console.log(`Dashboard visual disponible en http://localhost:${PORT}`);
});
