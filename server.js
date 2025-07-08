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
    const relativeVelocityX = ball.dx - paddle.vx;
    const relativeVelocityY = ball.dy - paddle.vy;
    const speed = Math.sqrt(relativeVelocityX ** 2 + relativeVelocityY ** 2);
    return { hit: true, hitPos, speed };
  }
  return { hit: false, hitPos: 0, speed: 0 };
}

function normalizeSpeed(dx, dy, targetSpeed) {
  const currentSpeed = Math.sqrt(dx * dx + dy * dy);
  if (currentSpeed === 0) return { dx, dy };
  const factor = targetSpeed / currentSpeed;
  return { dx: dx * factor, dy: dy * factor };
}

let players = [];
let gameState = {
  paddle1: { x: 0.5, y: 0.9333, score: 0, vx: 0, vy: 0 },
  paddle2: { x: 0.5, y: 0.0667, score: 0, vx: 0, vy: 0 },
  ball: { x: 0.5, y: 0.5, dx: 0, dy: 0 },
  status: "waiting",
  servingPlayer: 1,
  serveTimer: 7,
  gameTimer: 300,
  lastHitPlayer: null,
  hitTimer: 7,
  lastPing: new Map(),
  newGameRequests: new Set(),
};

function updateGame() {
  if (gameState.status !== "playing") return;

  if (gameState.gameTimer > 0) {
    gameState.gameTimer -= 1 / 60;
  } else {
    gameState.status = "gameOver";
    let winner;
    if (gameState.paddle1.score > gameState.paddle2.score) {
      winner = 1;
    } else if (gameState.paddle2.score < gameState.paddle1.score) {
      winner = 2;
    } else {
      winner = "ничья";
    }
    broadcast({
      type: "gameOver",
      winner,
      finalScore: `${gameState.paddle1.score} - ${gameState.paddle2.score}`,
    });
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
    gameState.ball.x =
      gameState.servingPlayer === 1
        ? gameState.paddle1.x + 0.0333
        : gameState.paddle2.x + 0.0333;
    gameState.ball.y = gameState.servingPlayer === 1 ? 0.9 : 0.1;
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

  let wallHit = false;
  let ballRadius = 0.01;
  let paddleWidth = 0.0667;
  let paddleHeight = 0.0333;
  let baseSpeed = 0.008;
  let maxSpeed = 0.015;

  if (gameState.ball.x <= 0.01 || gameState.ball.x >= 1 - 0.01) {
    gameState.ball.dx *= -1;
    gameState.ball.x = constrain(gameState.ball.x, 0.01, 1 - 0.01);
    const normalized = normalizeSpeed(
      gameState.ball.dx,
      gameState.ball.dy,
      baseSpeed
    );
    gameState.ball.dx = normalized.dx;
    gameState.ball.dy = normalized.dy;
    wallHit = true;
  }

  if (
    gameState.ball.y < 0.01 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    gameState.paddle1.score += 1;
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
      goal: 1,
    });
  } else if (
    gameState.ball.y > 1 - 0.01 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    gameState.paddle2.score += 1;
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
      goal: 2,
    });
  } else if (gameState.ball.y <= 0.01 || gameState.ball.y >= 1 - 0.01) {
    gameState.ball.dy *= -1;
    gameState.ball.y = constrain(gameState.ball.y, 0.01, 1 - 0.01);
    const normalized = normalizeSpeed(
      gameState.ball.dx,
      gameState.ball.dy,
      baseSpeed
    );
    gameState.ball.dx = normalized.dx;
    gameState.ball.dy = normalized.dy;
    wallHit = true;
  }

  let hit = false;
  let collision1 = checkPaddleCollision(
    gameState.ball,
    gameState.paddle1,
    paddleWidth,
    paddleHeight,
    ballRadius
  );
  if (collision1.hit) {
    let hitPos = collision1.hitPos;
    if (
      gameState.ball.dx === 0 &&
      gameState.ball.dy === 0 &&
      gameState.servingPlayer === 1
    ) {
      const speed = baseSpeed;
      gameState.ball.dx = hitPos * 0.004 + gameState.paddle1.vx * 0.5;
      gameState.ball.dy = -speed;
      const normalized = normalizeSpeed(
        gameState.ball.dx,
        gameState.ball.dy,
        speed
      );
      gameState.ball.dx = normalized.dx;
      gameState.ball.dy = normalized.dy;
      gameState.ball.y = gameState.paddle1.y - ballRadius;
      gameState.lastHitPlayer = 1;
      gameState.serveTimer = 7;
      gameState.hitTimer = 7;
      hit = true;
    } else {
      const speed = Math.min(collision1.speed * 0.8 + baseSpeed, maxSpeed);
      gameState.ball.dx = hitPos * 0.004 + gameState.paddle1.vx * 0.5;
      gameState.ball.dy = -Math.abs(gameState.ball.dy) * 0.8 - baseSpeed;
      const normalized = normalizeSpeed(
        gameState.ball.dx,
        gameState.ball.dy,
        speed
      );
      gameState.ball.dx = normalized.dx;
      gameState.ball.dy = normalized.dy;
      gameState.ball.y = gameState.paddle1.y - ballRadius;
      gameState.lastHitPlayer = 1;
      gameState.hitTimer = 7;
      hit = true;
    }
  }

  let collision2 = checkPaddleCollision(
    gameState.ball,
    gameState.paddle2,
    paddleWidth,
    paddleHeight,
    ballRadius
  );
  if (collision2.hit) {
    let hitPos = collision2.hitPos;
    if (
      gameState.ball.dx === 0 &&
      gameState.ball.dy === 0 &&
      gameState.servingPlayer === 2
    ) {
      const speed = baseSpeed;
      gameState.ball.dx = hitPos * 0.004 + gameState.paddle2.vx * 0.5;
      gameState.ball.dy = speed;
      const normalized = normalizeSpeed(
        gameState.ball.dx,
        gameState.ball.dy,
        speed
      );
      gameState.ball.dx = normalized.dx;
      gameState.ball.dy = normalized.dy;
      gameState.ball.y = gameState.paddle2.y + paddleHeight + ballRadius;
      gameState.lastHitPlayer = 2;
      gameState.serveTimer = 7;
      gameState.hitTimer = 7;
      hit = true;
    } else {
      const speed = Math.min(collision2.speed * 0.8 + baseSpeed, maxSpeed);
      gameState.ball.dx = hitPos * 0.004 + gameState.paddle2.vx * 0.5;
      gameState.ball.dy = Math.abs(gameState.ball.dy) * 0.8 + baseSpeed;
      const normalized = normalizeSpeed(
        gameState.ball.dx,
        gameState.ball.dy,
        speed
      );
      gameState.ball.dx = normalized.dx;
      gameState.ball.dy = normalized.dy;
      gameState.ball.y = gameState.paddle2.y + paddleHeight + ballRadius;
      gameState.lastHitPlayer = 2;
      gameState.hitTimer = 7;
      hit = true;
    }
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
  });
}

function broadcast(data) {
  players.forEach((player) => {
    if (player.readyState === WebSocket.OPEN) {
      try {
        player.send(JSON.stringify(data));
      } catch (error) {
        console.error(
          `Ошибка отправки сообщения игроку ${player.playerId}:`,
          error
        );
      }
    }
  });
}

function startGame() {
  gameState.status = "playing";
  gameState.paddle1 = { x: 0.5, y: 0.9333, score: 0, vx: 0, vy: 0 };
  gameState.paddle2 = { x: 0.5, y: 0.0667, score: 0, vx: 0, vy: 0 };
  gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
  gameState.serveTimer = 7;
  gameState.gameTimer = 300;
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
  gameState.paddle1 = { x: 0.5, y: 0.9333, score: 0, vx: 0, vy: 0 };
  gameState.paddle2 = { x: 0.5, y: 0.0667, score: 0, vx: 0, vy: 0 };
  gameState.ball = { x: 0.5, y: 0.5, dx: 0, dy: 0 };
  gameState.status = "waiting";
  gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
  gameState.serveTimer = 7;
  gameState.gameTimer = 300;
  gameState.lastHitPlayer = null;
  gameState.hitTimer = 7;
  gameState.newGameRequests.clear();
}

function resetBall(isNewGame) {
  gameState.ball.x =
    gameState.servingPlayer === 1
      ? gameState.paddle1.x + 0.0333
      : gameState.paddle2.x + 0.0333;
  gameState.ball.y = gameState.servingPlayer === 1 ? 0.9 : 0.1;
  gameState.ball.dx = 0;
  gameState.ball.dy = 0;
  gameState.serveTimer = 7;
  gameState.hitTimer = 7;
}

wss.on("connection", (ws) => {
  let playerId = players.length + 1;
  if (playerId > 2) {
    console.log(`Попытка подключения игрока ${playerId}, но игра заполнена`);
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
    console.log("Достаточно игроков, начинаем игру");
    startGame();
  }

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (
        data.type === "move" &&
        gameState.status === "playing" &&
        data.playerId &&
        data.position
      ) {
        const position = data.position;
        const paddle =
          data.playerId === 1 ? gameState.paddle1 : gameState.paddle2;

        if (
          (data.playerId === 1 && paddle !== gameState.paddle1) ||
          (data.playerId === 2 && paddle !== gameState.paddle2)
        ) {
          console.error(
            `Игрок ${data.playerId} пытается управлять чужой ракеткой!`
          );
          return;
        }

        // Дополнительная проверка координат
        if (
          data.playerId === 1 &&
          (position.y < 0.5 || position.y > 1 - 0.0333)
        ) {
          console.warn(`Игрок 1 отправил некорректный y: ${position.y}`);
          return;
        }
        if (
          data.playerId === 2 &&
          (position.y < 0 || position.y > 0.5 - 0.0333)
        ) {
          console.warn(`Игрок 2 отправил некорректный y: ${position.y}`);
          return;
        }

        const prevX = paddle.x;
        const prevY = paddle.y;
        paddle.x = constrain(position.x, 0, 1 - 0.0667);
        paddle.y = constrain(
          position.y,
          data.playerId === 1 ? 0.5 : 0,
          data.playerId === 1 ? 1 - 0.0333 : 0.5 - 0.0333 // Строже для игрока 2
        );
        paddle.vx = paddle.x - prevX;
        paddle.vy = paddle.y - prevY;

        // Логирование для отладки
        console.log(
          `Игрок ${data.playerId}: x=${paddle.x.toFixed(
            3
          )}, y=${paddle.y.toFixed(3)}`
        );

        broadcast({
          type: "update",
          paddle1: gameState.paddle1,
          paddle2: gameState.paddle2,
          ball: gameState.ball,
          servingPlayer: gameState.servingPlayer,
          serveTimer: gameState.serveTimer,
          gameTimer: gameState.gameTimer,
        });
      } else if (data.type === "newGame" && gameState.status === "gameOver") {
        gameState.newGameRequests.add(ws.playerId);
        if (gameState.newGameRequests.size === 2) {
          resetGame();
          startGame();
        }
      } else if (data.type === "ping") {
        gameState.lastPing.set(ws, Date.now());
      }
    } catch (error) {
      console.error(
        `Ошибка обработки сообщения от игрока ${ws.playerId}:`,
        error
      );
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

setInterval(() => {
  const now = Date.now();
  players = players.filter((player) => {
    if (now - gameState.lastPing.get(player) > 1000000) {
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
