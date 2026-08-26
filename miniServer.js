const express = require("express");
const axios = require("axios");

const app = express();

// Habilita la lectura de cuerpos de peticiones en formato JSON
app.use(express.json());

const PORT = process.argv[2];
const NAME = process.argv[3];

const MIDDLEWARE_URL = "http://localhost:3000";
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

// SERVER
app.listen(PORT, async () => {
  console.log(`Server corriendo en http://localhost:${PORT}`);

  try {
    await axios.post(`${MIDDLEWARE_URL}/register`, {
      name: NAME,
      url: `https://elinor-globose-jonah.ngrok-free.dev`,
    });

    console.log("Registrado sog");

    pulseInterval = setInterval(async () => {
      try {
        await axios.post(`${MIDDLEWARE_URL}/heartbeat/${NAME}`);
        console.log("Pulso enviado");
      } catch (error) {
        console.log("Error al enviar pulso");
      }
    }, 5000);
  } catch (error) {
    console.log("Error al registrar sog");
  }
});
