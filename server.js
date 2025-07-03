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

function checkPaddleCollision(
  ball,
  paddle,
  paddleWidth,
  paddleHeight,
  ballRadius
) {
  const ballX = ball.x;
  const ballY = ball.y;
  const paddleX = paddle.x;
  const paddleY = paddle.y;

  if (
    ballX + ballRadius >= paddleX &&
    ballX - ballRadius <= paddleX + paddleWidth &&
    ballY + ballRadius >= paddleY &&
    ballY - ballRadius <= paddleY + paddleHeight
  ) {
    const hitPos = (ballX - paddleX - paddleWidth / 2) / (paddleWidth / 2);
    return { hit: true, hitPos };
  }
  return { hit: false, hitPos: 0 };
}

let players = [];
let gameState = {
  paddle1: { x: 0.5, y: 0.0667, score: 0, vx: 0, vy: 0, charge: 1 },
  paddle2: { x: 0.5, y: 0.9333, score: 0, vx: 0, vy: 0, charge: 1 },
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
  let playerId = players.length + 1;
  if (playerId > 2) {
    ws.send(JSON.stringify({ type: "error", message: "Игра уже заполнена!" }));
    ws.close();
    return;
  }

  players.push(ws);
  ws.playerId = playerId;
  gameState.lastPing.set(ws, Date.now());

  ws.send(JSON.stringify({ type: "init", playerId }));

  console.log(
    `Игрок ${playerId} подключился. Всего игроков: ${players.length}`
  );

  if (players.length === 2) {
    startGame();
  }

  ws.on("message", (message) => {
    const data = JSON.parse(message);
    if (
      data.type === "move" &&
      gameState.status === "playing" &&
      data.playerId
    ) {
      const direction = data.direction;
      const paddle =
        data.playerId === 1 ? gameState.paddle1 : gameState.paddle2;

      if (direction.x) {
        paddle.vx = direction.x;
        paddle.x = constrain(paddle.x + paddle.vx, 0, 1 - 0.0667);
      }
      if (direction.y) {
        paddle.vy = direction.y;
        paddle.y = constrain(
          paddle.y + direction.y,
          data.playerId === 1 ? 0 : 0.6,
          data.playerId === 1 ? 0.4 : 1 - 0.0333
        );
      }
    } else if (data.type === "newGame" && gameState.status === "gameOver") {
      gameState.newGameRequests.add(ws.playerId);
      if (gameState.newGameRequests.size === 2) {
        resetGame();
        startGame();
      }
    } else if (data.type === "ping") {
      gameState.lastPing.set(ws, Date.now());
    }
  });

  ws.on("close", () => {
    players = players.filter((p) => p !== ws);
    gameState.lastPing.delete(ws);
    console.log(
      `Игрок ${ws.playerId} отключился. Всего игроков: ${players.length}`
    );
    if (gameState.status === "playing") {
      gameState.status = "waiting";
      gameState.newGameRequests.clear();
      resetBall(true);
      broadcast({
        type: "error",
        message: "Игрок отключился. Ожидание нового игрока...",
      });
    }
  });
});

function startGame() {
  gameState.status = "playing";
  gameState.paddle1 = { x: 0.5, y: 0.0667, score: 0, vx: 0, vy: 0, charge: 1 };
  gameState.paddle2 = { x: 0.5, y: 0.9333, score: 0, vx: 0, vy: 0, charge: 1 };
  gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
  gameState.serveTimer = 7;
  gameState.gameTimer = 180;
  gameState.lastHitPlayer = null;
  gameState.hitTimer = 7;
  resetBall(true);

  broadcast({
    type: "start",
    paddle1: gameState.paddle1,
    paddle2: gameState.paddle2,
    ball: gameState.ball,
    servingPlayer: gameState.servingPlayer,
    serveTimer: gameState.serveTimer,
    gameTimer: gameState.gameTimer,
  });

  console.log("Игра началась!");
}

function resetGame() {
  gameState.paddle1 = { x: 0.5, y: 0.0667, score: 0, vx: 0, vy: 0, charge: 1 };
  gameState.paddle2 = { x: 0.5, y: 0.9333, score: 0, vx: 0, vy: 0, charge: 1 };
  gameState.ball = { x: 0.5, y: 0.5, dx: 0, dy: 0, spin: 0 };
  gameState.status = "waiting";
  gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
  gameState.serveTimer = 7;
  gameState.gameTimer = 180;
  gameState.lastGoal = null;
  gameState.newGameRequests.clear();
  gameState.lastHitPlayer = null;
  gameState.hitTimer = 7;
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
    // Следим за положением мяча во время подачи
    gameState.ball.x =
      gameState.servingPlayer === 1
        ? gameState.paddle1.x + 0.0333
        : gameState.paddle2.x + 0.0333;
    gameState.ball.y = gameState.servingPlayer === 1 ? 0.1 : 0.9;
  } else {
    gameState.hitTimer -= 1 / 60;
    if (gameState.hitTimer <= 0) {
      gameState.servingPlayer = gameState.lastHitPlayer === 1 ? 2 : 1;
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
  }

  gameState.ball.x += gameState.ball.dx;
  gameState.ball.y += gameState.ball.dy;
  gameState.ball.dx *= 0.995; // Трение
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

  let wallHit = false;
  if (gameState.ball.x <= 0.01 || gameState.ball.x >= 1 - 0.01) {
    gameState.ball.dx *= -1;
    gameState.ball.x = constrain(gameState.ball.x, 0.01, 1 - 0.01);
    wallHit = true;
  }

  let hit = false;
  let ballRadius = 0.01;
  let paddleWidth = 0.0667;
  let paddleHeight = 0.0333;

  // Проверка столкновения с ракеткой игрока 1
  let collision1 = checkPaddleCollision(
    gameState.ball,
    gameState.paddle1,
    paddleWidth,
    paddleHeight,
    ballRadius
  );
  if (collision1.hit) {
    let hitPos = collision1.hitPos;
    if (gameState.ball.dx === 0 && gameState.ball.dy === 0) {
      if (gameState.servingPlayer === 1) {
        // Подача: мяч всегда летит к игроку 2
        gameState.ball.dx = 0.004 * hitPos + gameState.paddle1.vx * 0.5;
        gameState.ball.dy = 0.008 * gameState.paddle1.charge; // Положительное значение для движения вниз
        gameState.ball.y = gameState.paddle1.y + paddleHeight + ballRadius;
        gameState.lastHitPlayer = 1;
        gameState.serveTimer = 7;
        gameState.hitTimer = 7;
        hit = true;
      }
    } else if (gameState.ball.dy > 0) {
      // Обычный удар: мяч отражается вниз
      gameState.ball.dx =
        0.005 * hitPos +
        gameState.paddle1.vx * 0.5 +
        (Math.random() - 0.5) * 0.002;
      gameState.ball.dy = -Math.abs(0.008 * gameState.paddle1.charge); // Отрицательное значение для движения вверх
      gameState.ball.y = gameState.paddle1.y + paddleHeight + ballRadius;
      gameState.lastHitPlayer = 1;
      gameState.hitTimer = 7;
      gameState.paddle1.charge = Math.min(gameState.paddle1.charge + 0.1, 2);
      hit = true;
    }
  }

  // Проверка столкновения с ракеткой игрока 2
  let collision2 = checkPaddleCollision(
    gameState.ball,
    gameState.paddle2,
    paddleWidth,
    paddleHeight,
    ballRadius
  );
  if (collision2.hit) {
    let hitPos = collision2.hitPos;
    if (gameState.ball.dx === 0 && gameState.ball.dy === 0) {
      if (gameState.servingPlayer === 2) {
        // Подача: мяч всегда летит к игроку 1
        gameState.ball.dx = 0.004 * hitPos + gameState.paddle2.vx * 0.5;
        gameState.ball.dy = -0.008 * gameState.paddle2.charge; // Отрицательное значение для движения вверх
        gameState.ball.y = gameState.paddle2.y - ballRadius;
        gameState.lastHitPlayer = 2;
        gameState.serveTimer = 7;
        gameState.hitTimer = 7;
        hit = true;
      }
    } else if (gameState.ball.dy < 0) {
      // Обычный удар: мяч отражается вверх
      gameState.ball.dx =
        0.005 * hitPos +
        gameState.paddle2.vx * 0.5 +
        (Math.random() - 0.5) * 0.002;
      gameState.ball.dy = Math.abs(0.008 * gameState.paddle2.charge); // Положительное значение для движения вниз
      gameState.ball.y = gameState.paddle2.y - ballRadius;
      gameState.lastHitPlayer = 2;
      gameState.hitTimer = 7;
      gameState.paddle2.charge = Math.min(gameState.paddle2.charge + 0.1, 2);
      hit = true;
    }
  }

  // Проверка голов
  let goal = null;
  if (
    gameState.ball.y < 0.01 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    gameState.paddle2.score += 1;
    goal = 2;
    gameState.servingPlayer = 1;
    resetBall(false);
  } else if (
    gameState.ball.y > 1 - 0.01 &&
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
    if (now - gameState.lastPing.get(player) > 100000000) {
      player.close();
      return false;
    }
    return true;
  });
  if (players.length < 2 && gameState.status === "playing") {
    gameState.status = "waiting";
    gameState.newGameRequests.clear();
    resetBall(true);
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
