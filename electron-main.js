/**
 * MCLJ
 */

const { app, BrowserWindow, shell, Menu } = require('electron');

// 去掉菜单栏
Menu.setApplicationMenu(null);
const path = require('path');
const fs = require('fs');

let splashWindow = null;
let mainWindow = null;

const portFile = path.join(app.getPath('userData'), '.port');
process.env.ELECTRON = 'true';
process.env.ELECTRON_PORT_FILE = portFile;

// 启动服务器（保留引用用于清理）
const serverModule = require('./server.js');
const { stopTunnel } = require('./lib/tunnel.js');

// ========== 启动画面 ==========

const SPLASH_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d0d;display:flex;align-items:center;justify-content:center;height:100vh;
font-family:'Microsoft YaHei',sans-serif;overflow:hidden;user-select:none;-webkit-app-region:drag}
.box{text-align:center;width:320px}
.logo{
    width:80px;height:80px;margin:0 auto 20px;
    background:linear-gradient(135deg,#5d8c3c,#3a7d3a);
    border-radius:18px;
    display:flex;align-items:center;justify-content:center;
    font-size:40px;
    box-shadow:0 0 40px rgba(93,140,60,0.3);
    animation:bounce 2s ease-in-out infinite;
}
@keyframes bounce{
    0%,100%{transform:translateY(0)}
    50%{transform:translateY(-8px)}
}
h1{font-size:32px;font-weight:900;color:#fff;letter-spacing:4px;margin-bottom:4px}
h1 span{color:#5d8c3c}
.ver{font-size:11px;color:#555;margin-bottom:24px}
.bar-track{
    width:100%;height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden;margin-bottom:12px
}
.bar-fill{
    width:0%;height:100%;background:linear-gradient(90deg,#5d8c3c,#7ec850);
    border-radius:2px;transition:width 0.3s;
    animation:progress 3s ease-in-out infinite;
}
@keyframes progress{
    0%{width:0%}
    30%{width:40%}
    60%{width:65%}
    85%{width:85%}
    100%{width:90%}
}
.status{font-size:12px;color:#666;transition:color 0.5s}
.status.done{color:#5d8c3c}
</style></head><body><div class="box">
<div class="logo">⛏</div>
<h1>M<span>CLJ</span></h1>
<div class="ver">v1.0.0</div>
<div class="bar-track"><div class="bar-fill" id="bar"></div></div>
<div class="status" id="status">正在初始化...</div>
</div>
<script>
var steps=['初始化引擎...','加载网络模块...','启动本地服务...','准备就绪 ✓'];
var i=0,bar=document.getElementById('bar'),st=document.getElementById('status');
function next(){if(i<steps.length){st.textContent=steps[i];if(i===steps.length-1){st.className='status done';bar.style.width='100%';bar.style.animation='none'}i++;if(i<steps.length)setTimeout(next,400+Math.random()*300)}}
setTimeout(next,200);
</script></body></html>`;

function createSplash() {
    splashWindow = new BrowserWindow({
        width: 420,
        height: 380,
        frame: false,
        transparent: false,
        resizable: false,
        alwaysOnTop: true,
        center: true,
        backgroundColor: '#0d0d0d',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        show: true
    });
    splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
}

// ========== 主窗口 ==========

function createMainWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 650,
        title: 'MCLJ',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        backgroundColor: '#0d0d0d',
        show: false
    });

    mainWindow.loadURL(`http://localhost:${port}/minecraft`);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        // 关闭启动画面
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ========== 启动流程 ==========

app.whenReady().then(() => {
    // 1. 立即显示启动画面
    createSplash();

    // 2. 等待服务器就绪
    function getPort() {
        try { return parseInt(fs.readFileSync(portFile, 'utf-8').trim()) || 3000; }
        catch(e) { return 0; }
    }

    // 轮询端口，最多等 8 秒
    let waited = 0;
    function checkPort() {
        const port = getPort();
        if (port > 0) {
            // 额外确认服务器真的在响应
            const http = require('http');
            const req = http.get(`http://localhost:${port}/minecraft`, (res) => {
                createMainWindow(port);
            });
            req.on('error', () => {
                if (waited < 8000) { waited += 150; setTimeout(checkPort, 150); }
                else createMainWindow(port); // 超时也打开
            });
            req.setTimeout(1000, () => req.destroy());
        } else if (waited < 8000) {
            waited += 150;
            setTimeout(checkPort, 150);
        } else {
            createMainWindow(3000); // 超时默认端口
        }
    }
    setTimeout(checkPort, 300);
});

app.on('window-all-closed', () => { app.quit(); });

// ---- 退出时清理隧道和服务 ----
app.on('before-quit', async (event) => {
    // 防止重复清理
    if (app._cleaningUp) return;
    app._cleaningUp = true;
    event.preventDefault();

    console.log('[App] 正在清理...');

    // 1. 停止隧道（杀掉 SSH/ngrok 子进程）
    try {
        await stopTunnel();
        console.log('[App] 隧道已停止');
    } catch (e) { console.error('[App] 停止隧道失败:', e.message); }

    // 2. 关闭 HTTP 服务器
    if (serverModule.httpServer) {
        try {
            serverModule.httpServer.close();
            console.log('[App] HTTP 服务已关闭');
        } catch (e) { console.error('[App] 关闭服务失败:', e.message); }
    }

    // 强制杀掉可能残留的子进程
    try {
        require('child_process').execSync('taskkill /F /IM ssh.exe /T 2>nul & taskkill /F /IM ngrok.exe /T 2>nul', { stdio: 'ignore' });
    } catch (e) { /* ignore */ }

    app.exit(0);
});
