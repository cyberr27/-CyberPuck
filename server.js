const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

// Функция constrain для ограничения значений
function constrain(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

let players = [];
let gameState = {
  paddle1: { x: 0.5, y: 0.0667, score: 0, vx: 0 },
  paddle2: { x: 0.5, y: 0.9333, score: 0, vx: 0 },
  ball: { x: 0.5, y: 0.5, dx: 0, dy: 0, spin: 0 },
  status: "waiting",
  servingPlayer: 1,
  serveTimer: 10,
  gameTimer: 180,
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
        if (data.direction.x > 0 && gameState.paddle1.x < 1 - 0.0667)
          gameState.paddle1.x += data.direction.x;
        if (data.direction.y < 0 && gameState.paddle1.y > 0)
          gameState.paddle1.y += data.direction.y;
        if (data.direction.y > 0 && gameState.paddle1.y < 0.5 - 0.0333)
          gameState.paddle1.y += data.direction.y;
        gameState.paddle1.vx = data.direction.x || 0;
      } else if (playerId === 2) {
        if (data.direction.x < 0 && gameState.paddle2.x > 0)
          gameState.paddle2.x += data.direction.x;
        if (data.direction.x > 0 && gameState.paddle2.x < 1 - 0.0667)
          gameState.paddle2.x += data.direction.x;
        if (data.direction.y < 0 && gameState.paddle2.y > 0.5)
          gameState.paddle2.y += data.direction.y;
        if (data.direction.y > 0 && gameState.paddle2.y < 1 - 0.0333)
          gameState.paddle2.y += data.direction.y;
        gameState.paddle2.vx = data.direction.x || 0;
      }
    } else if (data.type === "serve" && playerId === gameState.servingPlayer) {
      let angle = (Math.PI / 4) * (data.direction || Math.random() - 0.5);
      let speed = 0.007 * data.charge;
      gameState.ball.dx = speed * Math.sin(angle);
      gameState.ball.dy =
        playerId === 1 ? speed * Math.cos(angle) : -speed * Math.cos(angle);
      gameState.ball.spin = data.direction * 0.3;
      gameState.serveTimer = 10;
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
    gameState.ball.dx += gameState.ball.spin * 0.0003;
    gameState.ball.spin *= 0.99;
    gameState.ball.dx *= 0.995;
    gameState.ball.dy *= 0.995;

    // Ограничение скорости мяча
    let speed = Math.sqrt(
      gameState.ball.dx * gameState.ball.dx +
        gameState.ball.dy * gameState.ball.dy
    );
    if (speed > 0.015) {
      let factor = 0.015 / speed;
      gameState.ball.dx *= factor;
      gameState.ball.dy *= factor;
    }
  }

  let wallHit = false;
  if (gameState.ball.x <= 0.0167 || gameState.ball.x >= 1 - 0.0167) {
    gameState.ball.dx *= -1;
    gameState.ball.x = constrain(gameState.ball.x, 0.0167, 1 - 0.0167);
    gameState.ball.spin *= -0.6;
    wallHit = true;
  }

  let hit = false;
  let ballRadius = 0.0083;
  let paddleWidth = 0.0667;
  let paddleHeight = 0.0333;

  // Столкновение с ракеткой игрока 1
  if (
    gameState.ball.y <= gameState.paddle1.y + paddleHeight + ballRadius &&
    gameState.ball.y >= gameState.paddle1.y - ballRadius &&
    gameState.ball.dy > 0 &&
    gameState.ball.x >= gameState.paddle1.x - ballRadius &&
    gameState.ball.x <= gameState.paddle1.x + paddleWidth + ballRadius
  ) {
    let hitPos =
      (gameState.ball.x - gameState.paddle1.x - paddleWidth / 2) /
      (paddleWidth / 2);
    gameState.ball.dx = 0.006 * hitPos + gameState.paddle1.vx * 0.4;
    gameState.ball.dy = -Math.abs(gameState.ball.dy) * 1.2;
    gameState.ball.spin = hitPos * 0.0015 + gameState.paddle1.vx * 0.2;
    gameState.ball.y = gameState.paddle1.y - ballRadius;
    gameState.ball.dx *= 1.1;
    hit = true;
  }
  // Столкновение с ракеткой игрока 2
  else if (
    gameState.ball.y >= gameState.paddle2.y - ballRadius &&
    gameState.ball.y <= gameState.paddle2.y + paddleHeight + ballRadius &&
    gameState.ball.dy < 0 &&
    gameState.ball.x >= gameState.paddle2.x - ballRadius &&
    gameState.ball.x <= gameState.paddle2.x + paddleWidth + ballRadius
  ) {
    let hitPos =
      (gameState.ball.x - gameState.paddle2.x - paddleWidth / 2) /
      (paddleWidth / 2);
    gameState.ball.dx = 0.006 * hitPos + gameState.paddle2.vx * 0.4;
    gameState.ball.dy = Math.abs(gameState.ball.dy) * 1.2;
    gameState.ball.spin = hitPos * 0.0015 + gameState.paddle2.vx * 0.2;
    gameState.ball.y = gameState.paddle2.y + ballRadius;
    gameState.ball.dx *= 1.1;
    hit = true;
  }

  let goal = null;
  if (
    gameState.ball.y < 0.0083 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    gameState.paddle2.score += 1;
    goal = 2;
    resetBall(false);
  } else if (
    gameState.ball.y > 1 - 0.0083 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
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
    wallHit,
    goal,
  });
}

function resetBall(isNewGame) {
  gameState.ball.x =
    gameState.servingPlayer === 1
      ? gameState.paddle1.x + 0.0333
      : gameState.paddle2.x + 0.0333;
  gameState.ball.y = gameState.servingPlayer === 1 ? 0.1 : 0.9;
  gameState.ball.dx = 0;
  gameState.ball.dy = 0;
  gameState.ball.spin = 0;
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
    if (now - player.lastPing > 10000) {
      // Уменьшено до 10 секунд для более быстрого обнаружения отключения
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

server.listen(process.env.PORT || 10000, () => {
  console.log("Сервер запущен на порту", server.address().port);
});
