/**
 * MCLJ — Minecraft 联机工具
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

// 设置 ELECTRON 标记，server.js 检测到后不会打开浏览器
process.env.ELECTRON = 'true';

// 直接加载服务器（不 spawn 子进程，避免打包后死循环）
require('./server.js');

function createWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 650,
        title: 'MCLJ',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        backgroundColor: '#0d0d0d',
        show: false
    });

    mainWindow.loadURL(`http://localhost:${port}/minecraft`);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    // 服务已通过 require('./server.js') 启动
    // 给服务器一点启动时间，然后打开窗口
    function getServerPort() {
    try {
        const port = fs.readFileSync(path.join(__dirname, '.port'), 'utf-8').trim();
        return parseInt(port) || 3000;
    } catch(e) { return 3000; }
}

setTimeout(() => {
    const port = getServerPort();
    console.log(`服务器端口: ${port}`);
    createWindow(port);
}, 2000);
});

app.on('window-all-closed', () => {
    app.quit();
});
