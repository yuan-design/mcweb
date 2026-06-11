/**
 * MCLJ — Minecraft 联机工具
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow = null;
let serverProcess = null;
let actualPort = null;
const START_PORT = 34789;

function startServer() {
    return new Promise((resolve, reject) => {
        const serverPath = path.join(__dirname, 'server.js');
        serverProcess = spawn(process.execPath, [serverPath], {
            env: { ...process.env, PORT: String(START_PORT), ELECTRON: 'true' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        let started = false;
        let outputBuffer = '';

        serverProcess.stdout?.on('data', (data) => {
            const text = data.toString();
            outputBuffer += text;
            console.log('[Server]', text.trim());

            // 从输出中提取实际端口：地址: http://localhost:XXXX
            const portMatch = outputBuffer.match(/localhost:(\d+)/);
            if (portMatch && !actualPort) {
                actualPort = parseInt(portMatch[1]);
            }

            if (!started && text.includes('MCLJ 已启动')) {
                started = true;
                resolve(actualPort || START_PORT);
            }
        });

        serverProcess.stderr?.on('data', (data) => {
            console.error('[Server]', data.toString().trim());
        });

        serverProcess.on('error', (err) => {
            if (!started) reject(err);
        });

        serverProcess.on('exit', (code) => {
            if (!started) reject(new Error(`服务器异常退出 (code ${code})`));
        });

        setTimeout(() => {
            if (!started) {
                started = true;
                resolve(actualPort || START_PORT);
            }
        }, 6000);
    });
}

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

    const url = `http://localhost:${port}/minecraft`;
    console.log('加载页面:', url);
    mainWindow.loadURL(url);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // 外部链接在浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    try {
        console.log('正在启动服务...');
        const port = await startServer();
        console.log(`服务已启动 (端口 ${port})`);
        createWindow(port);
    } catch (err) {
        dialog.showErrorBox('启动失败', `无法启动服务: ${err.message}`);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    cleanup();
    app.quit();
});

app.on('before-quit', () => {
    cleanup();
});

function cleanup() {
    if (serverProcess) {
        try { serverProcess.kill(); } catch (e) {}
        serverProcess = null;
    }
}
