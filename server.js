const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

function constrain(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

let players = [];
let gameState = {
  paddle1: { x: 0.5, y: 0.0667, score: 0, vx: 0, charge: 1 },
  paddle2: { x: 0.5, y: 0.9333, score: 0, vx: 0, charge: 1 },
  ball: { x: 0.5, y: 0.5, dx: 0, dy: 0, spin: 0 },
  status: "waiting",
  servingPlayer: 1,
  serveTimer: 7,
  gameTimer: 180,
  lastGoal: null,
  newGameRequests: new Set(),
  lastPing: new Map(),
  lastHitPlayer: null,
  hitTimer: 7,
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
    gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
    gameState.serveTimer = 7;
    gameState.gameTimer = 180;
    gameState.newGameRequests.clear();
    resetBall(true);
    broadcast({
      type: "start",
      servingPlayer: gameState.servingPlayer,
      serveTimer: gameState.serveTimer,
      gameTimer: gameState.gameTimer,
      paddle1: gameState.paddle1,
      paddle2: gameState.paddle2,
      ball: gameState.ball,
    });
  }

  ws.on("message", (message) => {
    const data =
      typeof message === "string"
        ? JSON.parse(message)
        : JSON.parse(message.toString());
    ws.lastPing = Date.now();
    if (data.type === "move" && gameState.status === "playing") {
      const paddle = playerId === 1 ? gameState.paddle1 : gameState.paddle2;
      const maxSpeed = 0.0078;
      const maxYSpeed = 0.0111;

      // Движение по X
      if (data.direction.x) {
        paddle.x += data.direction.x;
        paddle.x = constrain(paddle.x, 0, 1 - 0.0667);
        paddle.vx = data.direction.x;
      } else {
        paddle.vx = 0;
      }

      // Движение по Y с асимметрией
      if (playerId === 1 && data.direction.y) {
        paddle.y += data.direction.y;
        paddle.y = constrain(paddle.y, 0, 0.4); // Ограничение до y = 0.4
      } else if (playerId === 2 && data.direction.y) {
        paddle.y += data.direction.y;
        paddle.y = constrain(paddle.y, 0.6, 1 - 0.0333); // Ограничение от y = 0.6
      }

      // Проверка фола за пересечение центральной линии
      if (playerId === 1 && paddle.y > 0.4) {
        gameState.servingPlayer = 2;
        resetBall(false);
        broadcast({
          type: "update",
          paddle1: gameState.paddle1,
          paddle2: gameState.paddle2,
          ball: gameState.ball,
          servingPlayer: gameState.servingPlayer,
          serveTimer: gameState.serveTimer,
          gameTimer: gameState.gameTimer,
          foul: true,
        });
      } else if (playerId === 2 && paddle.y < 0.6) {
        gameState.servingPlayer = 1;
        resetBall(false);
        broadcast({
          type: "update",
          paddle1: gameState.paddle1,
          paddle2: gameState.paddle2,
          ball: gameState.ball,
          servingPlayer: gameState.servingPlayer,
          serveTimer: gameState.serveTimer,
          gameTimer: gameState.gameTimer,
          foul: true,
        });
      }
    } else if (data.type === "newGame" && gameState.status === "gameOver") {
      gameState.newGameRequests.add(playerId);
      if (gameState.newGameRequests.size === 2) {
        gameState.status = "playing";
        gameState.paddle1.score = 0;
        gameState.paddle2.score = 0;
        gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
        gameState.serveTimer = 7;
        gameState.gameTimer = 180;
        gameState.newGameRequests.clear();
        resetBall(true);
        broadcast({
          type: "start",
          servingPlayer: gameState.servingPlayer,
          serveTimer: gameState.serveTimer,
          gameTimer: gameState.gameTimer,
          paddle1: gameState.paddle1,
          paddle2: gameState.paddle2,
          ball: gameState.ball,
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

  if (gameState.ball.dx === 0 && gameState.ball.dy === 0) {
    gameState.serveTimer -= 1 / 60;
    if (gameState.serveTimer <= 0) {
      gameState.servingPlayer = gameState.servingPlayer === 1 ? 2 : 1;
      resetBall(false);
      broadcast({
        type: "update",
        paddle1: gameState.paddle1,
        paddle2: gameState.paddle2,
        ball: gameState.ball,
        servingPlayer: gameState.servingPlayer,
        serveTimer: gameState.serveTimer,
        gameTimer: gameState.gameTimer,
        foul: true,
      });
      return;
    }
  } else {
    gameState.hitTimer -= 1 / 60;
    if (gameState.hitTimer <= 0) {
      gameState.servingPlayer = gameState.lastHitPlayer === 1 ? 2 : 1;
      resetBall(false);
      gameState.hitTimer = 7;
      broadcast({
        type: "update",
        paddle1: gameState.paddle1,
        paddle2: gameState.paddle2,
        ball: gameState.ball,
        servingPlayer: gameState.servingPlayer,
        serveTimer: gameState.serveTimer,
        gameTimer: gameState.gameTimer,
        foul: true,
      });
      return;
    }
  }

  // Обновление позиции мяча
  gameState.ball.x += gameState.ball.dx;
  gameState.ball.y += gameState.ball.dy;
  gameState.ball.dx *= 0.995; // Затухание
  gameState.ball.dy *= 0.995;

  // Ограничение максимальной скорости
  let speed = Math.sqrt(
    gameState.ball.dx * gameState.ball.dx +
      gameState.ball.dy * gameState.ball.dy
  );
  if (speed > 0.015) {
    let factor = 0.015 / speed;
    gameState.ball.dx *= factor;
    gameState.ball.dy *= factor;
  }

  // Отскок от боковых стен
  let wallHit = false;
  if (gameState.ball.x <= 0.0167 || gameState.ball.x >= 1 - 0.0167) {
    gameState.ball.dx *= -1;
    gameState.ball.x = constrain(gameState.ball.x, 0.0167, 1 - 0.0167);
    wallHit = true;
  }

  // Обработка столкновений с ракетками
  let hit = false;
  let ballRadius = 0.0083;
  let paddleWidth = 0.0667;
  let paddleHeight = 0.0333;

  if (
    gameState.ball.y <= gameState.paddle1.y + paddleHeight + ballRadius &&
    gameState.ball.y >= gameState.paddle1.y - ballRadius &&
    gameState.ball.x >= gameState.paddle1.x - ballRadius &&
    gameState.ball.x <= gameState.paddle1.x + paddleWidth + ballRadius
  ) {
    let hitPos =
      (gameState.ball.x - gameState.paddle1.x - paddleWidth / 2) /
      (paddleWidth / 2);
    let charge = gameState.ball.dx === 0 && gameState.ball.dy === 0 ? 1.5 : 1.2;
    if (gameState.ball.dx === 0 && gameState.ball.dy === 0) {
      if (gameState.servingPlayer === 1) {
        // Подача игрока 1 (вниз)
        gameState.ball.dx = 0.003 * hitPos;
        gameState.ball.dy = 0.008 * charge; // Преимущественно вниз
        gameState.lastHitPlayer = 1;
        gameState.serveTimer = 7;
        gameState.hitTimer = 7;
      }
    } else if (gameState.ball.dy > 0) {
      // Обычный удар (мяч идет вниз)
      gameState.ball.dx = 0.004 * hitPos + gameState.paddle1.vx * 0.4;
      gameState.ball.dy = -Math.abs(gameState.ball.dy) * charge; // Обратно вверх
      gameState.ball.y = gameState.paddle1.y - ballRadius;
      gameState.lastHitPlayer = 1;
      gameState.hitTimer = 7;
    }
    hit = true;
  } else if (
    gameState.ball.y >= gameState.paddle2.y - ballRadius &&
    gameState.ball.y <= gameState.paddle2.y + paddleHeight + ballRadius &&
    gameState.ball.x >= gameState.paddle2.x - ballRadius &&
    gameState.ball.x <= gameState.paddle2.x + paddleWidth + ballRadius
  ) {
    let hitPos =
      (gameState.ball.x - gameState.paddle2.x - paddleWidth / 2) /
      (paddleWidth / 2);
    let charge = gameState.ball.dx === 0 && gameState.ball.dy === 0 ? 1.5 : 1.2;
    if (gameState.ball.dx === 0 && gameState.ball.dy === 0) {
      if (gameState.servingPlayer === 2) {
        // Подача игрока 2 (вверх)
        gameState.ball.dx = 0.003 * hitPos;
        gameState.ball.dy = -0.008 * charge; // Преимущественно вверх
        gameState.lastHitPlayer = 2;
        gameState.serveTimer = 7;
        gameState.hitTimer = 7;
      }
    } else if (gameState.ball.dy < 0) {
      // Обычный удар (мяч идет вверх)
      gameState.ball.dx = 0.004 * hitPos + gameState.paddle2.vx * 0.4;
      gameState.ball.dy = Math.abs(gameState.ball.dy) * charge; // Обратно вниз
      gameState.ball.y = gameState.paddle2.y + ballRadius;
      gameState.lastHitPlayer = 2;
      gameState.hitTimer = 7;
    }
    hit = true;
  }

  // Обработка голов
  let goal = null;
  if (
    gameState.ball.y < 0.0083 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    gameState.paddle2.score += 1;
    goal = 2;
    gameState.servingPlayer = 1;
    resetBall(false);
  } else if (
    gameState.ball.y > 1 - 0.0083 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    gameState.paddle1.score += 1;
    goal = 1;
    gameState.servingPlayer = 2;
    resetBall(false);
  }

  // Проверка конца игры
  if (gameState.paddle1.score >= 7) {
    gameState.status = "gameOver";
    broadcast({ type: "gameOver", winner: 1 });
  } else if (gameState.paddle2.score >= 7) {
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
  gameState.serveTimer = 7;
  gameState.hitTimer = 7;
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

server.listen(process.env.PORT || 10000, () => {
  console.log("Сервер запущен на порту", server.address().port);
});
