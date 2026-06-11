/**
 * MCLJ — Minecraft 联机工具
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

// 用可写目录存端口文件
const portFile = path.join(app.getPath('userData'), '.port');

// 设置 ELECTRON 标记
process.env.ELECTRON = 'true';
process.env.ELECTRON_PORT_FILE = portFile;

// 加载服务器（异步，不阻塞窗口显示）
require('./server.js');

// 加载中页面
const LOADING_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{background:#0d0d0d;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
font-family:'Microsoft YaHei',sans-serif;color:#888;}
.box{text-align:center}
.spinner{width:40px;height:40px;border:3px solid #333;border-top:3px solid #5d8c3c;border-radius:50%;
animation:spin 0.8s linear infinite;margin:0 auto 16px;}
@keyframes spin{to{transform:rotate(360deg)}}
h2{color:#fff;font-size:18px;margin:0 0 4px 0}
p{font-size:13px;margin:0}
</style></head><body><div class="box">
<div class="spinner"></div>
<h2>MCLJ</h2><p>正在启动...</p>
</div></body></html>`;

function createWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 650,
        title: 'MCLJ',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        backgroundColor: '#0d0d0d',
        show: true  // ← 立即显示
    });

    // 先显示加载页
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);

    // 等待服务器就绪
    function tryLoad(retries = 0) {
        const http = require('http');
        const req = http.get(`http://localhost:${port}/minecraft`, (res) => {
            if (res.statusCode === 200) {
                // 服务器就绪，加载真实页面
                mainWindow.loadURL(`http://localhost:${port}/minecraft`);
            } else if (retries < 20) {
                setTimeout(() => tryLoad(retries + 1), 200);
            }
        });
        req.on('error', () => {
            if (retries < 20) setTimeout(() => tryLoad(retries + 1), 200);
            else mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!DOCTYPE html><html><body style="background:#0d0d0d;color:#e74c3c;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;"><div><h2>启动失败</h2><p>请重新打开程序</p></div></body></html>')}`);
        });
        req.setTimeout(1000, () => req.destroy());
    }

    setTimeout(() => tryLoad(), 100);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
    function getPort() {
        try { return parseInt(fs.readFileSync(portFile, 'utf-8').trim()) || 3000; }
        catch(e) { return 3000; }
    }

    // 快速轮询端口
    let waited = 0;
    const check = () => {
        const port = getPort();
        if (port !== 3000 || waited >= 5000) {
            createWindow(port || 3000);
        } else {
            waited += 200;
            setTimeout(check, 200);
        }
    };
    setTimeout(check, 200);
});

app.on('window-all-closed', () => { app.quit(); });
