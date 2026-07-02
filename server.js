require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const corsConfig = require('./config/cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Habilitar CORS usando la configuración en /config/cors.js
app.use(cors(corsConfig));

app.use(express.json());
const routes = require('./routes');

// página principal
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Welcome</title>
        <style>
          body{
            margin:0;
            height:100vh;
            display:flex;
            justify-content:center;
            align-items:center;
            background:#111;
            color:white;
            font-family:Arial;
          }

          h1{
            font-size:60px;
          }
        </style>
      </head>
      <body>
        <h1>🚀 Welcome Node App</h1>
      </body>
    </html>
  `);
});

app.use('/api', routes);

// http server + websocket
const server = http.createServer(app);
const ws = require('./utils/ws');
ws.init(server);
const sunatService = require('./services/sunatService');

server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  sunatService.startWorker();
});

function shutdown() {
  sunatService.stopWorker();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
