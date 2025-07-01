const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let players = [];
let gameState = {
  paddle1: { x: 400, y: 30, score: 0, vx: 0 }, // Добавляем скорость ракетки
  paddle2: { x: 400, y: 420, score: 0, vx: 0 },
  ball: { x: 450, y: 225, dx: 0, dy: 0, spin: 0 },
  status: "waiting",
  servingPlayer: 1,
  serveTimer: 10,
  gameTimer: 180,
  tableHits: { player1: 0, player2: 0 },
  lastGoal: null,
  newGameRequests: new Set(),
  lastPing: new Map(),
};

wss.on("connection", (ws) => {
  if (players.length >= 2) {
    ws.send(JSON.stringify({ type: "error", message: "Игра уже полна!" }));
    ws.close();
    return;
  }

  const playerId = players.length + 1;
  players.push(ws);
  ws.playerId = playerId;
  ws.lastPing = Date.now();
  ws.send(JSON.stringify({ type: "init", playerId }));

  if (players.length === 2) {
    gameState.status = "playing";
    gameState.servingPlayer = 1;
    gameState.serveTimer = 10;
    gameState.gameTimer = 180;
    gameState.newGameRequests.clear();
    resetBall(true);
    broadcast({
      type: "start",
      servingPlayer: gameState.servingPlayer,
      serveTimer: gameState.serveTimer,
      gameTimer: gameState.gameTimer,
    });
  }

  ws.on("message", (message) => {
    const data =
      typeof message === "string"
        ? JSON.parse(message)
        : JSON.parse(message.toString());
    ws.lastPing = Date.now();
    if (data.type === "move" && gameState.status === "playing") {
      if (playerId === 1) {
        if (data.direction.x < 0 && gameState.paddle1.x > 0)
          gameState.paddle1.x += data.direction.x;
        if (data.direction.x > 0 && gameState.paddle1.x < 840)
          gameState.paddle1.x += data.direction.x;
        if (data.direction.y < 0 && gameState.paddle1.y > 0)
          gameState.paddle1.y += data.direction.y;
        if (data.direction.y > 0 && gameState.paddle1.y < 210)
          gameState.paddle1.y += data.direction.y;
        gameState.paddle1.vx = data.direction.x || 0; // Сохраняем скорость ракетки
      } else if (playerId === 2) {
        if (data.direction.x < 0 && gameState.paddle2.x > 0)
          gameState.paddle2.x += data.direction.x;
        if (data.direction.x > 0 && gameState.paddle2.x < 840)
          gameState.paddle2.x += data.direction.x;
        if (data.direction.y < 0 && gameState.paddle2.y > 240)
          gameState.paddle2.y += data.direction.y;
        if (data.direction.y > 0 && gameState.paddle2.y < 435)
          gameState.paddle2.y += data.direction.y;
        gameState.paddle2.vx = data.direction.x || 0;
      }
    } else if (data.type === "serve" && playerId === gameState.servingPlayer) {
      let angle = (Math.random() * Math.PI) / 10;
      let speed = 6 * data.charge;
      gameState.ball.dx =
        speed * Math.sin(angle) * (Math.random() > 0.5 ? 1 : -1);
      gameState.ball.dy = playerId === 1 ? speed : -speed;
      gameState.ball.spin = 0;
      gameState.serveTimer = 10;
      gameState.tableHits = { player1: 0, player2: 0 };
    } else if (data.type === "newGame" && gameState.status === "gameOver") {
      gameState.newGameRequests.add(playerId);
      if (gameState.newGameRequests.size === 2) {
        gameState.status = "playing";
        gameState.paddle1.score = 0;
        gameState.paddle2.score = 0;
        gameState.servingPlayer = 1;
        gameState.serveTimer = 10;
        gameState.gameTimer = 180;
        gameState.newGameRequests.clear();
        resetBall(true);
        broadcast({
          type: "start",
          servingPlayer: gameState.servingPlayer,
          serveTimer: gameState.serveTimer,
          gameTimer: gameState.gameTimer,
        });
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
      gameState.newGameRequests.clear();
      broadcast({
        type: "error",
        message: "Игрок отключился. Ожидание нового игрока...",
      });
    }
  });
});

function updateGame() {
  if (gameState.status !== "playing") return;

  if (gameState.gameTimer > 0) {
    gameState.gameTimer -= 1 / 60;
  } else {
    gameState.status = "gameOver";
    const winner = gameState.paddle1.score > gameState.paddle2.score ? 1 : 2;
    broadcast({ type: "gameOver", winner });
    return;
  }

  if (
    gameState.serveTimer > 0 &&
    gameState.ball.dx === 0 &&
    gameState.ball.dy === 0
  ) {
    gameState.serveTimer -= 1 / 60;
    if (gameState.serveTimer <= 0) {
      gameState.servingPlayer = gameState.servingPlayer === 1 ? 2 : 1;
      resetBall(false);
    }
  } else {
    gameState.ball.x += gameState.ball.dx;
    gameState.ball.y += gameState.ball.dy;
    gameState.ball.dx += gameState.ball.spin * 0.05; // Усиливаем влияние спина
    gameState.ball.spin *= 0.98; // Затухание спина
  }

  if (gameState.ball.x <= 15 || gameState.ball.x >= 885) {
    gameState.ball.dx *= -1;
    gameState.ball.spin *= -0.5;
  }

  let hit = false;
  let tableHit = false;
  // Проверка столкновения с плоскостью ракетки 1
  if (
    gameState.ball.y <= gameState.paddle1.y &&
    gameState.ball.dy > 0 &&
    gameState.ball.x >= gameState.paddle1.x &&
    gameState.ball.x <= gameState.paddle1.x + 60
  ) {
    let hitPos = (gameState.ball.x - gameState.paddle1.x - 30) / 30;
    gameState.ball.dx = 4 * hitPos + gameState.paddle1.vx * 0.2; // Учитываем скорость ракетки
    gameState.ball.dy = -Math.abs(gameState.ball.dy + 0.5) * 1.15;
    gameState.ball.spin = hitPos * 0.8 + gameState.paddle1.vx * 0.1;
    gameState.ball.dx *= 1.1;
    if (Math.abs(gameState.ball.dx) > 10)
      gameState.ball.dx = 10 * Math.sign(gameState.ball.dx); // Ограничение скорости
    if (Math.abs(gameState.ball.dy) > 16)
      gameState.ball.dy = 16 * Math.sign(gameState.ball.dy);
    hit = true;
    gameState.tableHits.player1 = 0;
  }
  // Проверка столкновения с плоскостью ракетки 2
  else if (
    gameState.ball.y >= gameState.paddle2.y + 15 &&
    gameState.ball.dy < 0 &&
    gameState.ball.x >= gameState.paddle2.x &&
    gameState.ball.x <= gameState.paddle2.x + 60
  ) {
    let hitPos = (gameState.ball.x - gameState.paddle2.x - 30) / 30;
    gameState.ball.dx = 4 * hitPos + gameState.paddle2.vx * 0.2;
    gameState.ball.dy = Math.abs(gameState.ball.dy + 0.5) * 1.15;
    gameState.ball.spin = hitPos * 0.8 + gameState.paddle2.vx * 0.1;
    gameState.ball.dx *= 1.1;
    if (Math.abs(gameState.ball.dx) > 10)
      gameState.ball.dx = 10 * Math.sign(gameState.ball.dx);
    if (Math.abs(gameState.ball.dy) > 16)
      gameState.ball.dy = halo16 * Math.sign(gameState.ball.dy);
    hit = true;
    gameState.tableHits.player2 = 0;
  } else if (
    gameState.ball.y >= 225 &&
    gameState.ball.y <= 230 &&
    gameState.ball.dy > 0 &&
    gameState.tableHits.player2 === 0
  ) {
    gameState.ball.y = 225;
    gameState.ball.dy *= -0.9;
    gameState.ball.spin *= 0.8;
    gameState.tableHits.player2 = 1;
    tableHit = true;
  } else if (
    gameState.ball.y <= 225 &&
    gameState.ball.y >= 220 &&
    gameState.ball.dy < 0 &&
    gameState.tableHits.player1 === 0
  ) {
    gameState.ball.y = 225;
    gameState.ball.dy *= -0.9;
    gameState.ball.spin *= 0.8;
    gameState.tableHits.player1 = 1;
    tableHit = true;
  }

  let goal = null;
  if (
    gameState.ball.y < 0 ||
    (gameState.ball.y <= 225 && gameState.tableHits.player1 >= 1)
  ) {
    gameState.paddle2.score += 1;
    goal = 2;
    resetBall(false);
  } else if (
    gameState.ball.y > 450 ||
    (gameState.ball.y >= 225 && gameState.tableHits.player2 >= 1)
  ) {
    gameState.paddle1.score += 1;
    goal = 1;
    resetBall(false);
  }

  if ((gameState.paddle1.score + gameState.paddle2.score) % 2 === 0 && goal) {
    gameState.servingPlayer = gameState.servingPlayer === 1 ? 2 : 1;
  }

  if (
    gameState.paddle1.score >= 11 &&
    gameState.paddle1.score >= gameState.paddle2.score + 2
  ) {
    gameState.status = "gameOver";
    broadcast({ type: "gameOver", winner: 1 });
  } else if (
    gameState.paddle2.score >= 11 &&
    gameState.paddle2.score >= gameState.paddle1.score + 2
  ) {
    gameState.status = "gameOver";
    broadcast({ type: "gameOver", winner: 2 });
  }

  broadcast({
    type: "update",
    paddle1: gameState.paddle1,
    paddle2: gameState.paddle2,
    ball: gameState.ball,
    servingPlayer: gameState.servingPlayer,
    serveTimer: gameState.serveTimer,
    gameTimer: gameState.gameTimer,
    hit,
    tableHit,
    goal,
  });
}

function resetBall(isNewGame) {
  gameState.ball.x =
    gameState.servingPlayer === 1
      ? gameState.paddle1.x + 30
      : gameState.paddle2.x + 30;
  gameState.ball.y = gameState.servingPlayer === 1 ? 45 : 405;
  gameState.ball.dx = 0;
  gameState.ball.dy = 0;
  gameState.ball.spin = 0;
  gameState.tableHits = { player1: 0, player2: 0 };
  gameState.serveTimer = 10;
}

function broadcast(data) {
  players.forEach((player) => {
    if (player.readyState === WebSocket.OPEN) {
      player.send(JSON.stringify(data));
    }
  });
}

setInterval(() => {
  const now = Date.now();
  players = players.filter((player) => {
    if (now - player.lastPing > 100000000) {
      player.close();
      return false;
    }
    return true;
  });
  if (players.length < 2 && gameState.status === "playing") {
    gameState.status = "waiting";
    gameState.newGameRequests.clear();
    broadcast({
      type: "error",
      message: "Игрок отключился. Ожидание нового игрока...",
    });
  }
}, 5000);

setInterval(updateGame, 1000 / 60);

server.listen(process.env.PORT || 3000, () => {
  console.log("Сервер запущен на порту", server.address().port);
});
