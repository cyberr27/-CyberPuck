const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Определяем baseSpeed и maxSpeed в глобальной области видимости
const baseSpeed = 0.008;
const maxSpeed = 0.015;

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

function checkGoalkeeperCollision(ball, paddle, playerId, baseSpeed, maxSpeed) {
  if (!paddle.bonus || paddle.bonus.type !== "lightning_goalkeeper") {
    return { hit: false, speed: 0 };
  }
  const t = (Math.sin(Date.now() * 0.012) + 1) / 2;
  const goalkeeperX = 0.25 + t * (0.75 - 0.25); // Движение вратаря по оси X
  const goalkeeperWidth = 0.0667; // Размер как у ракетки
  const goalkeeperHeight = 0.0333; // Размер как у ракетки
  const goalkeeperY = playerId === 1 ? 0.9333 : 0.0667; // Позиция Y как у ракетки
  const ballRadius = 0.01;

  if (
    ball.x + ballRadius >= goalkeeperX - goalkeeperWidth / 2 &&
    ball.x - ballRadius <= goalkeeperX + goalkeeperWidth / 2 &&
    ball.y + ballRadius >= goalkeeperY - goalkeeperHeight / 2 &&
    ball.y - ballRadius <= goalkeeperY + goalkeeperHeight / 2
  ) {
    // Вычисляем позицию удара относительно центра вратаря
    const hitPos = (ball.x - goalkeeperX) / (goalkeeperWidth / 2);
    let speed = Math.min(baseSpeed * 1.5, maxSpeed); // Скорость отскока
    let dx = hitPos * 0.004; // Угол отскока по X
    let dy = playerId === 1 ? -speed : speed; // Направление в сторону противника
    const normalized = normalizeSpeed(dx, dy, speed);
    paddle.bonus = null; // Вратарь исчезает после касания
    return { hit: true, dx: normalized.dx, dy: normalized.dy, speed };
  }
  return { hit: false, speed: 0 };
}

function normalizeSpeed(dx, dy, targetSpeed) {
  const currentSpeed = Math.sqrt(dx * dx + dy * dy);
  if (currentSpeed === 0) return { dx, dy };
  const factor = targetSpeed / currentSpeed;
  return { dx: dx * factor, dy: dy * factor };
}

function checkBonusCollision(ball, bonus, ballRadius) {
  const cellWidth = 2 / 30; // Увеличенная ширина бонуса (2 клетки)
  const cellHeight = 2 / 20; // Увеличенная высота бонуса (2 клетки)
  return (
    ball.x + ballRadius >= bonus.x - cellWidth / 2 &&
    ball.x - ballRadius <= bonus.x + cellWidth / 2 &&
    ball.y + ballRadius >= bonus.y - cellHeight / 2 &&
    ball.y - ballRadius <= bonus.y + cellHeight / 2
  );
}

let players = [];
let gameState = {
  paddle1: { x: 0.5, y: 0.9333, score: 0, vx: 0, vy: 0, bonus: null },
  paddle2: { x: 0.5, y: 0.0667, score: 0, vx: 0, vy: 0, bonus: null },
  ball: { x: 0.5, y: 0.5, dx: 0, dy: 0 },
  status: "waiting",
  servingPlayer: 1,
  serveTimer: 7,
  gameTimer: 300,
  lastHitPlayer: null,
  hitTimer: 7,
  lastPing: new Map(),
  newGameRequests: new Set(),
  bonuses: [],
  bonusTimer: 30,
};

const bonusTypes = ["burning_boot", "lightning_goalkeeper"];

function spawnBonus() {
  const cellWidth = 1 / 30;
  const cellHeight = 1 / 20;
  const centerX = 0.5;
  const centerY = 0.5;
  const rangeX = 3 * cellWidth; // 3 клетки влево и вправо от центра
  const rangeY = 3 * cellHeight; // 3 клетки вверх и вниз от центра

  // Ограничиваем X от 12 до 18 клеток (0.4 до 0.6 в нормализованных координатах)
  const gridX = Math.floor(Math.random() * 7) - 3; // -3 до +3 клетки
  const gridY = Math.floor(Math.random() * 7) - 3; // -3 до +3 клетки
  const bonusX = constrain(centerX + gridX * cellWidth, 0.4, 0.6); // Ограничение по X
  const bonusY = centerY + gridY * cellHeight;

  const bonusType = bonusTypes[Math.floor(Math.random() * bonusTypes.length)];

  gameState.bonuses = [
    {
      x: bonusX,
      y: bonusY,
      type: bonusType,
    },
  ];
}

function applyBonus(player, bonusType) {
  if (bonusType === "burning_boot") {
    player.bonus = { type: "burning_boot", hits: 1 };
  } else if (bonusType === "lightning_goalkeeper") {
    player.bonus = { type: "lightning_goalkeeper" }; // Убрали duration
  }
}

function updateGame() {
  let wallHit = false;
  let ballRadius = 0.01;
  let paddleWidth = 0.0667;
  let paddleHeight = 0.0333;

  if (gameState.status !== "playing") return;

  // Обновление таймера бонуса "Молниеносный вратарь"
  if (
    gameState.paddle1.bonus &&
    gameState.paddle1.bonus.type === "lightning_goalkeeper"
  ) {
    gameState.paddle1.bonus.duration -= 1 / 60;
    if (gameState.paddle1.bonus.duration <= 0) {
      gameState.paddle1.bonus = null;
    }
  }
  if (
    gameState.paddle2.bonus &&
    gameState.paddle2.bonus.type === "lightning_goalkeeper"
  ) {
    gameState.paddle2.bonus.duration -= 1 / 60;
    if (gameState.paddle2.bonus.duration <= 0) {
      gameState.paddle2.bonus = null;
    }
  }

  // Появление бонуса через 30 секунд после начала
  if (gameState.gameTimer <= 270) {
    gameState.bonusTimer -= 1 / 30;
    if (gameState.bonusTimer <= 0) {
      spawnBonus();
      gameState.bonusTimer = 30;
    }
  }

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

  let goalkeeperHit = false;

  // Проверка столкновения с воротами (только в зоне ворот: x от 0.25 до 0.75)
  if (
    gameState.ball.y <= 0.01 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    const goalkeeperCollision = checkGoalkeeperCollision(
      gameState.ball,
      gameState.paddle1,
      1,
      baseSpeed,
      maxSpeed
    );
    if (goalkeeperCollision.hit) {
      gameState.ball.dx = goalkeeperCollision.dx;
      gameState.ball.dy = goalkeeperCollision.dy;
      gameState.ball.y = 0.01 + ballRadius;
      gameState.lastHitPlayer = 1;
      gameState.hitTimer = 7;
      broadcast({
        type: "update",
        paddle1: gameState.paddle1,
        paddle2: gameState.paddle2,
        ball: gameState.ball,
        servingPlayer: gameState.servingPlayer,
        serveTimer: gameState.serveTimer,
        gameTimer: gameState.gameTimer,
        bonuses: gameState.bonuses,
        hit: true, // Считаем это как обычный удар для звука
        goalkeeperHit: true,
      });
    } else {
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
        bonuses: gameState.bonuses,
        goal: 1,
      });
      return;
    }
  } else if (
    gameState.ball.y >= 1 - 0.01 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    const goalkeeperCollision = checkGoalkeeperCollision(
      gameState.ball,
      gameState.paddle2,
      2,
      baseSpeed,
      maxSpeed
    );
    if (goalkeeperCollision.hit) {
      gameState.ball.dx = goalkeeperCollision.dx;
      gameState.ball.dy = goalkeeperCollision.dy;
      gameState.ball.y = 1 - 0.01 - ballRadius;
      gameState.lastHitPlayer = 2;
      gameState.hitTimer = 7;
      broadcast({
        type: "update",
        paddle1: gameState.paddle1,
        paddle2: gameState.paddle2,
        ball: gameState.ball,
        servingPlayer: gameState.servingPlayer,
        serveTimer: gameState.serveTimer,
        gameTimer: gameState.gameTimer,
        bonuses: gameState.bonuses,
        hit: true, // Считаем это как обычный удар для звука
        goalkeeperHit: true,
      });
    } else {
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
        bonuses: gameState.bonuses,
        goal: 2,
      });
      return;
    }
  } 
  else if (
    gameState.ball.y >= 1 - 0.01 &&
    gameState.ball.x >= 0.25 &&
    gameState.ball.x <= 0.75
  ) {
    const goalkeeperCollision = checkGoalkeeperCollision(
      gameState.ball,
      gameState.paddle2,
      2,
      baseSpeed,
      maxSpeed
    );
    if (goalkeeperCollision.hit) {
      gameState.ball.dx = goalkeeperCollision.dx;
      gameState.ball.dy = goalkeeperCollision.dy;
      gameState.ball.y = 1 - 0.01 - ballRadius;
      gameState.lastHitPlayer = 2;
      gameState.hitTimer = 7;
      goalkeeperHit = true;
    } else {
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
        bonuses: gameState.bonuses,
        goal: 2,
      });
      return; // Выходим, чтобы избежать дальнейшей обработки
    }
  }

  // Проверка столкновения с верхней/нижней стенкой (вне зоны ворот)
  if (
    (gameState.ball.y <= 0.01 &&
      (gameState.ball.x < 0.25 || gameState.ball.x > 0.75)) ||
    (gameState.ball.y >= 1 - 0.01 &&
      (gameState.ball.x < 0.25 || gameState.ball.x > 0.75))
  ) {
    gameState.ball.dy *= -1;
    gameState.ball.y = constrain(gameState.ball.y, 0.01, 1 - 0.01);
    wallHit = true;
  }

  // Проверка столкновения с боковыми стенками
  if (gameState.ball.x <= 0.01 || gameState.ball.x >= 1 - 0.01) {
    gameState.ball.dx *= -1;
    gameState.ball.x = constrain(gameState.ball.x, 0.01, 1 - 0.01);
    wallHit = true;
  }

  // Проверка на фол при неподвижном мяче
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
        bonuses: gameState.bonuses,
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
        bonuses: gameState.bonuses,
        foul: true,
      });
      return;
    }
  }

  // Обновление позиции мяча
  gameState.ball.x += gameState.ball.dx;
  gameState.ball.y += gameState.ball.dy;

  // Проверка столкновения с бонусами
  let bonusCollected = null;
  gameState.bonuses = gameState.bonuses.filter((bonus) => {
    if (checkBonusCollision(gameState.ball, bonus, ballRadius)) {
      if (gameState.lastHitPlayer) {
        const player =
          gameState.lastHitPlayer === 1 ? gameState.paddle1 : gameState.paddle2;
        applyBonus(player, bonus.type);
        bonusCollected = {
          playerId: gameState.lastHitPlayer,
          bonusType: bonus.type,
        };
        gameState.bonusTimer = 30;
        return false;
      }
    }
    return true;
  });

  // Проверка столкновения с ракетками
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
    let speed = Math.min(collision1.speed * 0.8 + baseSpeed, maxSpeed);
    if (
      gameState.ball.dx === 0 &&
      gameState.ball.dy === 0 &&
      gameState.servingPlayer === 1
    ) {
      speed = baseSpeed;
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
      if (
        gameState.paddle1.bonus &&
        gameState.paddle1.bonus.type === "burning_boot"
      ) {
        speed *= 2.2;
        gameState.paddle1.bonus.hits -= 1;
        if (gameState.paddle1.bonus.hits <= 0) {
          gameState.paddle1.bonus = null;
        }
      }
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
    let speed = Math.min(collision2.speed * 0.8 + baseSpeed, maxSpeed);
    if (
      gameState.ball.dx === 0 &&
      gameState.ball.dy === 0 &&
      gameState.servingPlayer === 2
    ) {
      speed = baseSpeed;
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
      if (
        gameState.paddle2.bonus &&
        gameState.paddle2.bonus.type === "burning_boot"
      ) {
        speed *= 2.2;
        gameState.paddle2.bonus.hits -= 1;
        if (gameState.paddle2.bonus.hits <= 0) {
          gameState.paddle2.bonus = null;
        }
      }
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
    bonuses: gameState.bonuses,
    hit,
    wallHit,
    bonusCollected,
    goalkeeperHit,
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
  gameState.paddle1 = {
    x: 0.5,
    y: 0.9333,
    score: 0,
    vx: 0,
    vy: 0,
    bonus: null,
  };
  gameState.paddle2 = {
    x: 0.5,
    y: 0.0667,
    score: 0,
    vx: 0,
    vy: 0,
    bonus: null,
  };
  gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
  gameState.serveTimer = 7;
  gameState.gameTimer = 300;
  gameState.lastHitPlayer = null;
  gameState.hitTimer = 7;
  gameState.bonuses = [];
  gameState.bonusTimer = 30;
  resetBall(true);

  broadcast({
    type: "start",
    paddle1: gameState.paddle1,
    paddle2: gameState.paddle2,
    ball: gameState.ball,
    servingPlayer: gameState.servingPlayer,
    serveTimer: gameState.serveTimer,
    gameTimer: gameState.gameTimer,
    bonuses: gameState.bonuses,
  });

  console.log("Игра началась!");
}

function resetGame() {
  gameState.paddle1 = {
    x: 0.5,
    y: 0.9333,
    score: 0,
    vx: 0,
    vy: 0,
    bonus: null,
  };
  gameState.paddle2 = {
    x: 0.5,
    y: 0.0667,
    score: 0,
    vx: 0,
    vy: 0,
    bonus: null,
  };
  gameState.ball = { x: 0.5, y: 0.5, dx: 0, dy: 0 };
  gameState.status = "waiting";
  gameState.servingPlayer = Math.random() < 0.5 ? 1 : 2;
  gameState.serveTimer = 7;
  gameState.gameTimer = 300;
  gameState.lastHitPlayer = null;
  gameState.hitTimer = 7;
  gameState.bonuses = [];
  gameState.bonusTimer = 30;
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

        const paddleWidth = 0.0667;
        const paddleHeight = 0.0333;
        const prevX = paddle.x;
        const prevY = paddle.y;
        paddle.x = constrain(position.x, 0, 1 - paddleWidth);
        if (data.playerId === 1) {
          paddle.y = constrain(position.y, 0.5, 1 - paddleHeight);
        } else {
          paddle.y = constrain(position.y, 0, 0.5 - paddleHeight);
        }
        paddle.vx = paddle.x - prevX;
        paddle.vy = paddle.y - prevY;

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
          bonuses: gameState.bonuses,
        });
      } else if (data.type === "newGame" && gameState.status === "gameOver") {
        gameState.newGameRequests.add(ws.playerId);
        if (players.length === 2) {
          resetGame();
          startGame();
        } else {
          broadcast({
            type: "error",
            message: "Ожидание второго игрока для начала новой игры...",
          });
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
