const fs = require("fs");
const express = require("express");

const app = express();

app.use(express.json());
const PORT = 3000;

//Almacenamiento en memoria
let servers = {};

// Servers
let serverProcesses = {};
let nextPort = 4000;

//Get root
app.get("/", (req, res) => {
  res.send("Hola Mundo de Juan Diego");
});

//Registrar servidor
app.post("/register", (req, res) => {
  const { name, url } = req.body; //se crean dos constantes

  if (!name || !url) {
    return res.status(400).json({ error: "Name and URL required" });
  }

  servers[name] = {
    name,
    url,
    lastHeartbeat: Date.now(), //enviar pulsos para tener comunicacion con otro servidor
  };

  console.log(`Server registered succesfully: ${name}`);

  res.json({ message: "server registered successfully" });
});

//HeartBeat

app.post("/heartbeat/:name", (req, res) => {
  const { name } = req.params;

  if (servers[name]) {
    servers[name].lastHeartbeat = Date.now();
    return res.json({ message: "Hearbeat received" });
  }

  res.status(400).json({ error: "Server not found" });
});

//Eliminar Servidor
app.post("/kill-server/:name", (req, res) => {
  const { name } = req.params;

  if (!serverProcesses[name]) {
    return res.status(400).json({ error: "server not fund" });
  }

  serverProcesses[name].process.kill();
  delete serverProcesses[name];
  delete servers[name];

  console.log(`Server ${name} is killed`);
  res.json({ message: `${name} killed` });
});

//Obtener Servidores activos

app.get("/servers", (req, res) => {
  res.json(Object.values(servers));
});

// Timeout
setInterval(() => {
  const now = Date.now();
  const timeout = 15000;

  Object.keys(servers).forEach((name) => {
    if (now - servers[name].lastHeartbeat > timeout) {
      console.log(`Server ${name} timed out. Killingg..`);

      if (serverProcesses[name]) {
        serverProcesses[name].process.kill();
        delete serverProcesses[name];
      }
      delete servers[name];
    }
  });
}, 10000);

app.listen(PORT, () => {
  console.log(`middleware corrinedo en http://localhost:${PORT}`);
});

//MENSAJE RECIBIDO?
// app.post("/messages", (req, res) => {
//   const { sender, message } = req.body;
//   console.log(`[MENSAJE RECIBIDO de ${sender}]: ${message}`);
//   res.json({ status: "success", info: "Mensaje recibido" });
// });

// Estructura en memoria para almacenar mensajes por nodo
let messagesByServer = {};

// POST /send-message/:name -> Recibir/Guardar mensaje para un servidor
app.post("/send-message/:name", (req, res) => {
  const { name } = req.params;
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "El campo 'message' es obligatorio" });
  }

  if (!messagesByServer[name]) {
    messagesByServer[name] = [];
  }

  messagesByServer[name].push({
    message,
    timestamp: new Date().toISOString(),
  });

  console.log(`[MENSAJE para ${name}]: ${message}`);
  res.json({ status: "success", info: `Mensaje guardado para ${name}` });
});

// GET /send-message/:name -> Ver mensajes de un servidor específico
app.get("/send-message/:name", (req, res) => {
  const { name } = req.params;
  const messages = messagesByServer[name] || [];

  res.json({ server: name, messages });
});
