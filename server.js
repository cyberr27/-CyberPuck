const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public")); // Папка для index.html

let players = [];
let gameState = {
  paddle1: { y: 250, score: 0 },
  paddle2: { y: 250, score: 0 },
  ball: { x: 400, y: 300, dx: 5, dy: 5 },
  status: "waiting",
};

wss.on("connection", (ws) => {
  if (players.length >= 2) {
    ws.send(JSON.stringify({ type: "error", message: "Игра уже полна!" }));
    ws.close();
    return;
  }

  const playerId = players.length + 1;
  players.push(ws);
  ws.send(JSON.stringify({ type: "init", playerId }));

  if (players.length === 2) {
    gameState.status = "playing";
    broadcast({ type: "start" });
  }

  ws.on("message", (message) => {
    const data = JSON.parse(message);
    if (data.type === "move") {
      if (playerId === 1) {
        if (data.direction === "up" && gameState.paddle1.y > 0)
          gameState.paddle1.y -= 10;
        if (data.direction === "down" && gameState.paddle1.y < 500)
          gameState.paddle1.y += 10;
      } else if (playerId === 2) {
        if (data.direction === "up" && gameState.paddle2.y > 0)
          gameState.paddle2.y -= 10;
        if (data.direction === "down" && gameState.paddle2.y < 500)
          gameState.paddle2.y += 10;
      }
    }
  });

  ws.on("close", () => {
    players = players.filter((player) => player !== ws);
    if (gameState.status === "playing") {
      gameState.status = "waiting";
      broadcast({
        type: "error",
        message: "Игрок отключился. Ожидание нового игрока...",
      });
    }
  });
});

function updateGame() {
  if (gameState.status !== "playing") return;

  gameState.ball.x += gameState.ball.dx;
  gameState.ball.y += gameState.ball.dy;

  // Отскок от верхнего и нижнего борта
  if (gameState.ball.y <= 10 || gameState.ball.y >= 590) {
    gameState.ball.dy *= -1;
  }

  // Отскок от ракеток
  if (
    (gameState.ball.x <= 40 &&
      gameState.ball.x >= 30 &&
      gameState.ball.y >= gameState.paddle1.y &&
      gameState.ball.y <= gameState.paddle1.y + 100) ||
    (gameState.ball.x >= 760 &&
      gameState.ball.x <= 770 &&
      gameState.ball.y >= gameState.paddle2.y &&
      gameState.ball.y <= gameState.paddle2.y + 100)
  ) {
    gameState.ball.dx *= -1;
  }

  // Голы
  if (gameState.ball.x < 0) {
    gameState.paddle2.score += 1;
    resetBall();
  } else if (gameState.ball.x > 800) {
    gameState.paddle1.score += 1;
    resetBall();
  }

  // Победа
  if (gameState.paddle1.score >= 5) {
    gameState.status = "gameOver";
    broadcast({ type: "gameOver", winner: 1 });
  } else if (gameState.paddle2.score >= 5) {
    gameState.status = "gameOver";
    broadcast({ type: "gameOver", winner: 2 });
  }

  broadcast({
    type: "update",
    paddle1: gameState.paddle1,
    paddle2: gameState.paddle2,
    ball: gameState.ball,
  });
}

function resetBall() {
  gameState.ball.x = 400;
  gameState.ball.y = 300;
  gameState.ball.dx = 5 * (Math.random() > 0.5 ? 1 : -1);
  gameState.ball.dy = 5 * (Math.random() > 0.5 ? 1 : -1);
}

function broadcast(data) {
  players.forEach((player) => {
    if (player.readyState === WebSocket.OPEN) {
      player.send(JSON.stringify(data));
    }
  });
}

setInterval(updateGame, 1000 / 60); // 60 FPS

server.listen(process.env.PORT || 3000, () => {
  console.log("Сервер запущен на порту", server.address().port);
});
