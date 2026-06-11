/**
 * MCLJ — Minecraft 联机工具
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

// 用可写目录存端口文件
const portFile = path.join(app.getPath('userData'), '.port');

// 设置 ELECTRON 标记和端口文件路径
process.env.ELECTRON = 'true';
process.env.ELECTRON_PORT_FILE = portFile;

// 直接加载服务器
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

    // 页面加载失败时重试
    let retries = 0;
    mainWindow.webContents.on('did-fail-load', () => {
        if (retries < 5) {
            retries++;
            console.log(`加载失败，1秒后重试 (${retries}/5)...`);
            setTimeout(() => {
                if (mainWindow) {
                    mainWindow.loadURL(`http://localhost:${port}/minecraft`);
                }
            }, 1000);
        }
    });

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
    function getPort() {
        try {
            const p = fs.readFileSync(portFile, 'utf-8').trim();
            return parseInt(p) || 3000;
        } catch(e) { return 3000; }
    }

    // 等待服务器启动，最多等 5 秒
    let waited = 0;
    const check = () => {
        const port = getPort();
        if (port !== 3000 || waited >= 5000) {
            // 读到端口或超时，打开窗口
            console.log(`[Electron] 服务器端口: ${port} (等待 ${waited}ms)`);
            createWindow(port);
        } else {
            waited += 500;
            setTimeout(check, 500);
        }
    };
    setTimeout(check, 500);
});

app.on('window-all-closed', () => {
    app.quit();
});
