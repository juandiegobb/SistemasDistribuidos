const express = require("express");
const axios = require("axios");

const app = express();

// Habilita la lectura de cuerpos de peticiones en formato JSON
app.use(express.json());

const PORT = process.argv[2];
const NAME = process.argv[3];

let MIDDLEWARE_URL = "http://localhost:3000";
let pulseInterval;

// ROOT
app.get("/", (req, res) => {
  res.send(`Server running on port ${PORT}`);
});

// SHUTDOWN
app.post("/shutdown", (req, res) => {
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
    console.log("Dejó de enviar pulsos");
  }

  res.json({ message: `${NAME} dejó de enviar pulsos` });
});

// MATAR SERVIDOR (Finaliza el proceso por completo)
const handleKill = (req, res) => {
  console.log(`[KILL] Servidor ${NAME} apagándose por completo...`);
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
  }
  res.json({ message: `${NAME} ha sido detenido y el proceso ha finalizado` });
  setTimeout(() => {
    process.exit(0);
  }, 500);
};

app.post("/kill", handleKill);
app.get("/kill", handleKill);
app.post("/kill-server", handleKill);

// SEND MESSAGE
app.post("/send-message", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "El campo 'message' es obligatorio" });
  }

  try {
    const response = await axios.post(
      `${MIDDLEWARE_URL}/send-message/${NAME}`,
      {
        message,
      },
    );

    console.log(`Mensaje enviado al middleware: "${message}"`);
    res.json({ status: "success", serverResponse: response.data });
  } catch (error) {
    console.error("Error al enviar mensaje:", error.message);
    res
      .status(500)
      .json({ error: "No se pudo entregar el mensaje al middleware" });
  }
});

// HOTRELOAD - CAMBIAR URL PADRE
const updateParentUrl = async (req, res) => {
  const { newParentUrl } = req.body;

  if (!newParentUrl) {
    return res.status(400).json({ error: "El campo 'newParentUrl' es obligatorio" });
  }

  // 1. Actualizar la variable local MIDDLEWARE_URL
  MIDDLEWARE_URL = newParentUrl;

  // 2. Reiniciar el intervalo de heartbeats apuntando a la nueva dirección
  if (pulseInterval) {
    clearInterval(pulseInterval);
  }
  pulseInterval = setInterval(async () => {
    try {
      await axios.post(
        `${MIDDLEWARE_URL}/heartbeat/${NAME}`,
        {},
        {
          headers: { "ngrok-skip-browser-warning": "true" },
        }
      );
      console.log("Pulso enviado");
    } catch (error) {
      console.log("Error al enviar pulso");
    }
  }, 5000);

  // 3. Ejecutar de inmediato una petición POST /register contra el nuevo padre con las cabeceras de ngrok correspondientes
  try {
    await axios.post(
      `${MIDDLEWARE_URL}/register`,
      {
        name: NAME,
        url: `https://elinor-globose-jonah.ngrok-free.dev`,
      },
      {
        headers: { "ngrok-skip-browser-warning": "true" },
      }
    );
    console.log("Registrado sog");
  } catch (error) {
    console.log("Error al registrar sog");
  }

  res.json({ message: `URL padre actualizada a ${MIDDLEWARE_URL}` });
};

app.put("/config", updateParentUrl);
app.post("/update-parent-url", updateParentUrl);

// SERVER
app.listen(PORT, async () => {
  console.log(`Server corriendo en http://localhost:${PORT}`);

  try {
    await axios.post(
      `${MIDDLEWARE_URL}/register`,
      {
        name: NAME,
        url: `https://elinor-globose-jonah.ngrok-free.dev`,
      },
      {
        headers: { "ngrok-skip-browser-warning": "true" },
      }
    );

    console.log("Registrado sog");

    pulseInterval = setInterval(async () => {
      try {
        await axios.post(
          `${MIDDLEWARE_URL}/heartbeat/${NAME}`,
          {},
          {
            headers: { "ngrok-skip-browser-warning": "true" },
          }
        );
        console.log("Pulso enviado");
      } catch (error) {
        console.log("Error al enviar pulso");
      }
    }, 5000);
  } catch (error) {
    console.log("Error al registrar sog");
  }
});
