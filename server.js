const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let players = [];
let gameState = {
  paddle1: { x: 250, score: 0 },
  paddle2: { x: 250, score: 0 },
  ball: { x: 300, y: 400, dx: 0, dy: 0 },
  status: "waiting",
  startTime: null,
  timer: 180,
  lastGoal: null,
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
    resetBall(true);
    broadcast({ type: "start", timer: gameState.timer });
  }

  ws.on("message", (message) => {
    const data =
      typeof message === "string"
        ? JSON.parse(message)
        : JSON.parse(message.toString());
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

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
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

  gameState.timer = Math.max(
    0,
    180 - Math.floor((Date.now() - gameState.startTime) / 1000)
  );

  gameState.ball.x += gameState.ball.dx;
  gameState.ball.y += gameState.ball.dy;

  if (gameState.ball.x <= 10 || gameState.ball.x >= 590) {
    gameState.ball.dx *= -1;
  }

  let hit = false;
  if (
    gameState.ball.y <= 40 &&
    gameState.ball.y >= 30 &&
    gameState.ball.x >= gameState.paddle1.x &&
    gameState.ball.x <= gameState.paddle1.x + 100
  ) {
    let hitPos = (gameState.ball.x - gameState.paddle1.x - 50) / 50;
    gameState.ball.dx = 6 * hitPos;
    gameState.ball.dy = -Math.abs(gameState.ball.dy + 0.5) * 1.1;
    gameState.ball.dx *= 1.1;
    if (Math.abs(gameState.ball.dx) > 15)
      gameState.ball.dx = 15 * Math.sign(gameState.ball.dx);
    if (Math.abs(gameState.ball.dy) > 15)
      gameState.ball.dy = 15 * Math.sign(gameState.ball.dy);
    if (Math.abs(gameState.ball.dy) < 3) gameState.ball.dy = -3;
    hit = true;
  } else if (
    gameState.ball.y >= 760 &&
    gameState.ball.y <= 770 &&
    gameState.ball.x >= gameState.paddle2.x &&
    gameState.ball.x <= gameState.paddle2.x + 100
  ) {
    let hitPos = (gameState.ball.x - gameState.paddle2.x - 50) / 50;
    gameState.ball.dx = 6 * hitPos;
    gameState.ball.dy = Math.abs(gameState.ball.dy + 0.5) * 1.1;
    gameState.ball.dx *= 1.1;
    if (Math.abs(gameState.ball.dx) > 15)
      gameState.ball.dx = 15 * Math.sign(gameState.ball.dx);
    if (Math.abs(gameState.ball.dy) > 15)
      gameState.ball.dy = 15 * Math.sign(gameState.ball.dy);
    if (Math.abs(gameState.ball.dy) < 3) gameState.ball.dy = 3;
    hit = true;
  }

  let goal = null;
  if (gameState.ball.y < 0) {
    gameState.paddle2.score += 1;
    goal = 2;
    resetBall(false);
  } else if (gameState.ball.y > 800) {
    gameState.paddle1.score += 1;
    goal = 1;
    resetBall(false);
  }

  if (gameState.timer <= 0) {
    let winner =
      gameState.paddle1.score > gameState.paddle2.score
        ? 1
        : gameState.paddle2.score > gameState.paddle1.score
        ? 2
        : 0;
    if (winner === 0) {
      gameState.timer = 60;
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
    goal,
  });
}

function resetBall(isNewGame) {
  gameState.ball.x = 300;
  gameState.ball.y = 400;
  gameState.ball.dx = 0;
  gameState.ball.dy = 0;
  setTimeout(() => {
    if (isNewGame) {
      let angle = (Math.random() * Math.PI) / 2 + Math.PI / 4;
      if (Math.random() > 0.5) angle += Math.PI;
      gameState.ball.dx = 6 * Math.cos(angle);
      gameState.ball.dy = 6 * Math.sin(angle);
    } else {
      let angle = (Math.random() * Math.PI) / 2 + Math.PI / 4;
      if (gameState.lastGoal === 2) {
        gameState.ball.dy = Math.abs(6 * Math.sin(angle));
      } else {
        gameState.ball.dy = -Math.abs(6 * Math.sin(angle));
      }
      gameState.ball.dx = 6 * Math.cos(angle) * (Math.random() > 0.5 ? 1 : -1);
    }
    gameState.lastGoal =
      gameState.paddle2.score > gameState.paddle1.score ? 2 : 1;
  }, 1000);
}

function broadcast(data) {
  players.forEach((player) => {
    if (player.readyState === WebSocket.OPEN) {
      player.send(JSON.stringify(data));
    }
  });
}

setInterval(updateGame, 1000 / 60);

server.listen(process.env.PORT || 3000, () => {
  console.log("Сервер запущен на порту", server.address().port);
});
