const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// página principal
app.get("/", (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});