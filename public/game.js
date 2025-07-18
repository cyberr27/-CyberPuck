// Стартовый прототип RTS на Phaser
const config = {
    type: Phaser.AUTO,
    width: 900,
    height: 600,
    parent: 'game-container',
    backgroundColor: '#222244',
    physics: {
        default: 'arcade',
        arcade: { debug: false }
    },
    scene: {
        preload: preload,
        create: create,
        update: update
    }
};

let game = new Phaser.Game(config);
let socket;
let playerId;
let units = [];
let resources = [];
let buildings = [];

function preload() {
    this.load.image('tile', 'img/backgroundImg.jpg');
    this.load.image('unit', 'img/burning_boot.png');
    this.load.image('base', 'img/lightning_goalkeeper.png');
}

function create() {
    // Карта
    for (let x = 0; x < 15; x++) {
        for (let y = 0; y < 10; y++) {
            this.add.image(x * 60, y * 60, 'tile').setOrigin(0);
        }
    }
    // База игрока
    let base = this.physics.add.image(100, 500, 'base').setInteractive();
    buildings.push(base);
    // Юнит
    let unit = this.physics.add.image(150, 500, 'unit').setInteractive();
    units.push(unit);
    // Ресурс
    let res = this.physics.add.image(400, 300, 'unit').setTint(0xffff00);
    resources.push(res);
    // Сетевое подключение
    socket = new WebSocket('ws://' + window.location.host + '/ws');
    socket.onopen = () => {
        console.log('WS connected');
    };
    socket.onmessage = (event) => {
        // Обработка сетевых событий
    };
    // Управление юнитом
    this.input.on('pointerdown', (pointer) => {
        unit.x = pointer.x;
        unit.y = pointer.y;
        // Отправить действие на сервер
        socket.send(JSON.stringify({ type: 'move', unitId: 0, x: pointer.x, y: pointer.y }));
    });
}

function update() {
    // Логика игры (движение, сбор ресурсов, атака)
}
