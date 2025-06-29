const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public")); // Папка для index.html

let players = [];
let gameState = {
  paddle1: { x: 250, score: 0 },
  paddle2: { x: 250, score: 0 },
  ball: { x: 300, y: 400, dx: 5, dy: 5 },
  status: "waiting",
  startTime: null,
  timer: 180, // 3 минуты
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
    gameState.startTime = Date.now();
    gameState.timer = 180;
    resetBall();
    broadcast({ type: "start", timer: gameState.timer });
  }

  ws.on("message", (message) => {
    const data = JSON.parse(message);
    if (data.type === "move") {
      if (playerId === 1) {
        if (data.direction === "left" && gameState.paddle1.x > 0)
          gameState.paddle1.x -= 10;
        if (data.direction === "right" && gameState.paddle1.x < 500)
          gameState.paddle1.x += 10;
      } else if (playerId === 2) {
        if (data.direction === "left" && gameState.paddle2.x > 0)
          gameState.paddle2.x -= 10;
        if (data.direction === "right" && gameState.paddle2.x < 500)
          gameState.paddle2.x += 10;
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

  // Обновление таймера
  gameState.timer = Math.max(
    0,
    180 - Math.floor((Date.now() - gameState.startTime) / 1000)
  );

  // Обновление мяча
  gameState.ball.x += gameState.ball.dx;
  gameState.ball.y += gameState.ball.dy;

  // Отскок от левых и правых стенок
  if (gameState.ball.x <= 10 || gameState.ball.x >= 590) {
    gameState.ball.dx *= -1;
  }

  // Отскок от ракеток
  let hit = false;
  if (
    gameState.ball.y <= 40 &&
    gameState.ball.y >= 30 &&
    gameState.ball.x >= gameState.paddle1.x &&
    gameState.ball.x <= gameState.paddle1.x + 100
  ) {
    let hitPos = (gameState.ball.x - gameState.paddle1.x - 50) / 50; // -1..1
    gameState.ball.dx = 5 * hitPos;
    gameState.ball.dy = -Math.abs(gameState.ball.dy) * 1.05; // Ускорение
    gameState.ball.dx *= 1.05;
    if (Math.abs(gameState.ball.dx) > 12)
      gameState.ball.dx = 12 * Math.sign(gameState.ball.dx);
    if (Math.abs(gameState.ball.dy) > 12)
      gameState.ball.dy = 12 * Math.sign(gameState.ball.dy);
    hit = true;
  } else if (
    gameState.ball.y >= 760 &&
    gameState.ball.y <= 770 &&
    gameState.ball.x >= gameState.paddle2.x &&
    gameState.ball.x <= gameState.paddle2.x + 100
  ) {
    let hitPos = (gameState.ball.x - gameState.paddle2.x - 50) / 50; // -1..1
    gameState.ball.dx = 5 * hitPos;
    gameState.ball.dy = Math.abs(gameState.ball.dy) * 1.05; // Ускорение
    gameState.ball.dx *= 1.05;
    if (Math.abs(gameState.ball.dx) > 12)
      gameState.ball.dx = 12 * Math.sign(gameState.ball.dx);
    if (Math.abs(gameState.ball.dy) > 12)
      gameState.ball.dy = 12 * Math.sign(gameState.ball.dy);

    hit = true;
  }

  // Голы
  if (gameState.ball.y < 0) {
    gameState.paddle2.score += 1;
    resetBall();
  } else if (gameState.ball.y > 800) {
    gameState.paddle1.score += 1;
    resetBall();
  }

  // Проверка окончания раунда
  if (gameState.timer <= 0) {
    let winner =
      gameState.paddle1.score > gameState.paddle2.score
        ? 1
        : gameState.paddle2.score > gameState.paddle1.score
        ? 2
        : 0;
    if (winner === 0) {
      // Овертайм
      gameState.timer = 60; // Ещё 1 минута
      gameState.startTime = Date.now();
    } else {
      gameState.status = "gameOver";
      broadcast({ type: "gameOver", winner });
    }
  }

  broadcast({
    type: "update",
    paddle1: gameState.paddle1,
    paddle2: gameState.paddle2,
    ball: gameState.ball,
    timer: gameState.timer,
    hit,
  });
}

function resetBall() {
  gameState.ball.x = 300;
  gameState.ball.y = 400;
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
