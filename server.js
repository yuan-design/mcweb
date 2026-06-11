const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const net = require('net');
const dgram = require('dgram');
const axios = require('axios');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// 本地模块
const { pingServer } = require('./lib/mc-ping');
const { scanLAN, LANScanner } = require('./lib/lan-scanner');
const { setupMinecraftPortMapping } = require('./lib/upnp');
const { checkTunnelReady, startTunnel, stopTunnel, getTunnelStatus, onRenew } = require('./lib/tunnel');
const { setup: setupDDNS, getStatus: getDDNSStatus, updateIP: updateDDNS, onUpdate: onDDNSUpdate } = require('./lib/ddns');

const app = express();

// ---- 全局错误处理 ----
process.on('uncaughtException', (err) => {
    console.error('\n❌ 错误:', err.message);
    console.log('\n按 Enter 键退出...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(1));
    // 10秒后自动退出
    setTimeout(() => process.exit(1), 10000);
});

// ---- 自动打开浏览器 ----
function openBrowser(url) {
    const cmd = process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
            ? `open "${url}"`
            : `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.log(`💡 请手动打开浏览器: ${url}`);
        else console.log(`🌐 浏览器已打开: ${url}`);
    });
}

// ---- 静态文件（禁用缓存，确保每次都是最新版本）----
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
}));
app.get('/', (req, res) => res.redirect('/minecraft'));
app.get('/minecraft', (req, res) => sendHtml(res, 'minecraft.html'));
app.get('/tunnel', (req, res) => sendHtml(res, 'tunnel.html'));

function sendHtml(res, filename) {
    const fs = require('fs');
    const filepath = path.join(__dirname, 'public', filename);
    res.sendFile(filepath, (err) => {
        if (err) {
            try { res.type('html').send(fs.readFileSync(filepath, 'utf-8')); }
            catch (e) { res.status(500).send('加载失败'); }
        }
    });
}

// ---- 连接管理 ----
const activeConnections = new Map();

function closeConnection(socketId) {
    const conn = activeConnections.get(socketId);
    if (!conn) return;
    try {
        if (conn.type === 'tcp' && conn.client) conn.client.destroy();
        else if (conn.type === 'udp' && conn.client) conn.client.close();
    } catch (e) { /* ignore */ }
    activeConnections.delete(socketId);
}

// ---- 隧道续期广播 ----
onRenew((info) => {
    console.log(`[Tunnel] 📡 广播续期: ${info.newAddress || '失败'}`);
    io && io.emit('tunnel-renewed', info);
});

// ---- HTTP & Socket.IO 服务器 ----
let io;
const httpServer = http.createServer(app);

// ---- Socket.IO 事件 ----
function setupIO(srv) {
    io = new Server(srv);

    io.on('connection', (socket) => {
        console.log(`[+] 客户端: ${socket.id}`);

        // ===== TCP 客户端 =====
        socket.on('tcp-connect', (data) => {
            const { host, port, timeout = 10000 } = data;
            closeConnection(socket.id);
            const client = new net.Socket();
            let connected = false;
            client.setTimeout(timeout);
            client.connect(port, host, () => {
                connected = true;
                activeConnections.set(socket.id, { type: 'tcp', client, host, port });
                socket.emit('connection-status', { protocol: 'tcp', status: 'connected', host, port, message: `已连接 ${host}:${port}` });
            });
            client.on('data', (data) => socket.emit('data-received', { protocol: 'tcp', data: data.toString('utf-8'), hex: data.toString('hex'), size: data.length, timestamp: new Date().toISOString() }));
            client.on('timeout', () => { if (!connected) socket.emit('connection-status', { protocol: 'tcp', status: 'error', host, port, message: `连接超时` }); client.destroy(); activeConnections.delete(socket.id); });
            client.on('error', (err) => { socket.emit('connection-status', { protocol: 'tcp', status: 'error', host, port, message: err.message }); activeConnections.delete(socket.id); });
            client.on('close', () => { socket.emit('connection-status', { protocol: 'tcp', status: 'disconnected', host, port, message: `已断开` }); activeConnections.delete(socket.id); });
        });
        socket.on('tcp-send', (data) => {
            const conn = activeConnections.get(socket.id);
            if (!conn || conn.type !== 'tcp') return socket.emit('data-send-result', { success: false, message: '无活跃 TCP 连接' });
            try { const buf = Buffer.from(data, 'utf-8'); conn.client.write(buf); socket.emit('data-send-result', { success: true, message: `已发送 ${buf.length} 字节`, size: buf.length }); }
            catch (err) { socket.emit('data-send-result', { success: false, message: err.message }); }
        });

        // ===== UDP =====
        socket.on('udp-start', (data) => {
            const { host, port } = data;
            closeConnection(socket.id);
            try {
                const udp = dgram.createSocket('udp4');
                activeConnections.set(socket.id, { type: 'udp', client: udp, host, port });
                udp.on('message', (msg, rinfo) => socket.emit('data-received', { protocol: 'udp', data: msg.toString('utf-8'), hex: msg.toString('hex'), size: msg.length, from: `${rinfo.address}:${rinfo.port}`, timestamp: new Date().toISOString() }));
                udp.on('error', (err) => { socket.emit('connection-status', { protocol: 'udp', status: 'error', host, port, message: err.message }); activeConnections.delete(socket.id); });
                socket.emit('connection-status', { protocol: 'udp', status: 'ready', host, port, message: `UDP 就绪 → ${host}:${port}` });
            } catch (err) { socket.emit('connection-status', { protocol: 'udp', status: 'error', host, port, message: err.message }); }
        });
        socket.on('udp-send', (data) => {
            const conn = activeConnections.get(socket.id);
            if (!conn || conn.type !== 'udp') return socket.emit('data-send-result', { success: false, message: '无活跃 UDP 会话' });
            const buf = Buffer.from(data, 'utf-8');
            conn.client.send(buf, 0, buf.length, conn.port, conn.host, (err) => {
                socket.emit('data-send-result', err ? { success: false, message: err.message } : { success: true, message: `已发送 ${buf.length} 字节`, size: buf.length });
            });
        });

        // ===== HTTP =====
        socket.on('http-request', async (data) => {
            const { url, method = 'GET', headers = {}, body, timeout = 30000 } = data;
            socket.emit('connection-status', { protocol: 'http', status: 'connecting', url, message: `${method} ${url}` });
            const t0 = Date.now();
            try {
                const cfg = { method: method.toUpperCase(), url, headers, timeout, validateStatus: () => true, maxRedirects: 5 };
                if (body && method.toUpperCase() !== 'GET') cfg.data = body;
                const resp = await axios(cfg);
                const elapsed = Date.now() - t0;
                const resHeaders = {}; if (resp.headers) Object.entries(resp.headers).forEach(([k, v]) => resHeaders[k] = v);
                const bodyStr = typeof resp.data === 'object' ? JSON.stringify(resp.data, null, 2) : String(resp.data);
                socket.emit('http-response', { status: resp.status, statusText: resp.statusText, headers: resHeaders, body: bodyStr, contentType: resp.headers['content-type'] || '', elapsed, size: bodyStr.length, url, method });
                socket.emit('connection-status', { protocol: 'http', status: 'completed', url, message: `${resp.status} (${elapsed}ms)` });
            } catch (err) {
                socket.emit('http-response', { error: true, message: err.message, elapsed: Date.now() - t0, url, method });
                socket.emit('connection-status', { protocol: 'http', status: 'error', url, message: `失败: ${err.message}` });
            }
        });

        // ===== TCP 监听 =====
        socket.on('tcp-listen-start', (data) => {
            const { port, host = '0.0.0.0' } = data;
            closeConnection(socket.id);
            const tcpServer = net.createServer((clientSocket) => {
                const addr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
                socket.emit('data-received', { protocol: 'tcp-listen', data: `[新连接] ${addr}`, hex: '', size: 0, timestamp: new Date().toISOString() });
                clientSocket.on('data', (d) => socket.emit('data-received', { protocol: 'tcp-listen', data: d.toString('utf-8'), hex: d.toString('hex'), size: d.length, from: addr, timestamp: new Date().toISOString() }));
                clientSocket.on('error', (e) => socket.emit('data-received', { protocol: 'tcp-listen', data: `[错误] ${addr}: ${e.message}`, hex: '', size: 0, timestamp: new Date().toISOString() }));
                const c = activeConnections.get(socket.id); if (c) c.lastClient = clientSocket;
            });
            tcpServer.on('error', (err) => socket.emit('connection-status', { protocol: 'tcp-listen', status: 'error', host, port, message: err.message }));
            tcpServer.listen(port, host, () => { activeConnections.set(socket.id, { type: 'tcp-listen', client: tcpServer, host, port }); socket.emit('connection-status', { protocol: 'tcp-listen', status: 'listening', host, port, message: `监听 ${host}:${port}` }); });
        });
        socket.on('tcp-listen-send', (data) => {
            const conn = activeConnections.get(socket.id);
            if (!conn?.lastClient) return socket.emit('data-send-result', { success: false, message: '无连接客户端' });
            try { const buf = Buffer.from(data, 'utf-8'); conn.lastClient.write(buf); socket.emit('data-send-result', { success: true, message: `已发送 ${buf.length} 字节`, size: buf.length }); }
            catch (err) { socket.emit('data-send-result', { success: false, message: err.message }); }
        });

        // ===== UDP 监听 =====
        socket.on('udp-listen-start', (data) => {
            const { port, host = '0.0.0.0' } = data;
            closeConnection(socket.id);
            try {
                const udpSrv = dgram.createSocket('udp4');
                udpSrv.on('message', (msg, rinfo) => { socket.emit('data-received', { protocol: 'udp-listen', data: msg.toString('utf-8'), hex: msg.toString('hex'), size: msg.length, from: `${rinfo.address}:${rinfo.port}`, timestamp: new Date().toISOString() }); const c = activeConnections.get(socket.id); if (c) c.lastSender = rinfo; });
                udpSrv.on('error', (err) => { socket.emit('connection-status', { protocol: 'udp-listen', status: 'error', host, port, message: err.message }); activeConnections.delete(socket.id); });
                udpSrv.bind(port, host, () => { activeConnections.set(socket.id, { type: 'udp-listen', client: udpSrv, host, port }); socket.emit('connection-status', { protocol: 'udp-listen', status: 'listening', host, port, message: `UDP 监听 ${host}:${port}` }); });
            } catch (err) { socket.emit('connection-status', { protocol: 'udp-listen', status: 'error', host, port, message: err.message }); }
        });
        socket.on('udp-listen-send', (data) => {
            const conn = activeConnections.get(socket.id);
            if (!conn?.lastSender) return socket.emit('data-send-result', { success: false, message: '无可回复的发送者' });
            try { const buf = Buffer.from(data, 'utf-8'); conn.client.send(buf, 0, buf.length, conn.lastSender.port, conn.lastSender.address, (err) => { socket.emit('data-send-result', err ? { success: false, message: err.message } : { success: true, message: `已回复 ${buf.length} 字节`, size: buf.length }); }); }
            catch (err) { socket.emit('data-send-result', { success: false, message: err.message }); }
        });

        // ===== Minecraft =====
        socket.on('mc-ping', async (data) => {
            try { const info = await pingServer(data.host, data.port || 25565, data.timeout || 5000); socket.emit('mc-ping-result', { success: true, server: info }); }
            catch (err) { socket.emit('mc-ping-result', { success: false, host: data.host, port: data.port, error: err.message }); }
        });
        socket.on('mc-ping-batch', async (data) => {
            const results = await Promise.allSettled(data.servers.map(async (s) => { try { const info = await pingServer(s.host, s.port || 25565, data.timeout || 5000); return { ...s, online: true, info }; } catch (e) { return { ...s, online: false, error: e.message }; } }));
            socket.emit('mc-ping-batch-result', { servers: results.map(r => r.status === 'fulfilled' ? r.value : { ...r.reason, online: false }) });
        });
        socket.on('mc-lan-scan-start', () => {
            if (socket._lanScanner) socket._lanScanner.stop();
            const scanner = new LANScanner();
            socket._lanScanner = scanner;
            scanner.on('found', (g) => socket.emit('mc-lan-game-found', g));
            scanner.on('scanning', () => socket.emit('mc-lan-scan-status', { status: 'listening', message: '正在监听...' }));
            scanner.on('error', (e) => socket.emit('mc-lan-scan-status', { status: 'error', message: e.message }));
            scanner.start();
        });
        socket.on('mc-lan-scan-stop', () => { if (socket._lanScanner) { socket._lanScanner.stop(); socket._lanScanner = null; } });
        socket.on('mc-upnp-map', async (data) => {
            const port = (data && data.port) || 25565;
            socket.emit('mc-upnp-status', { status: 'working', message: '正在配置路由器...' });
            const result = await setupMinecraftPortMapping(port);
            socket.emit('mc-upnp-result', result);
        });
        socket.on('mc-network-info', () => {
            const ips = [];
            const ifaces = os.networkInterfaces();
            for (const [name, addrs] of Object.entries(ifaces))
                for (const addr of addrs)
                    if (addr.family === 'IPv4') ips.push({ name, address: addr.address, internal: addr.internal, netmask: addr.netmask });
            socket.emit('mc-network-info-result', { ips });
        });
        socket.on('mc-launch-join', async (data) => {
            const { host, port = 25565 } = data;
            let online = false, info = null;
            try { info = await pingServer(host, port, 5000); online = true; } catch (e) { /* offline */ }
            socket.emit('mc-launch-result', { success: online, serverInfo: info, host, port, connectCommand: `minecraft://connect?host=${host}&port=${port}`, directConnect: `${host}:${port}`, message: online ? `在线 ${host}:${port}` : `可能离线 ${host}:${port}` });
        });

        // ===== 隧道穿透 =====
        socket.on('tunnel-check', () => { socket.emit('tunnel-check-result', checkTunnelReady()); });

        // —— 配置 ngrok token ——
        socket.on('tunnel-setup-ngrok', (data) => {
            const token = (data && data.token || '').trim();
            if (!token) return socket.emit('tunnel-setup-result', { success: false, message: 'token 不能为空' });

            try {
                const fs = require('fs');
                const dir = process.env.APPDATA || process.env.LOCALAPPDATA;
                const cfgDir = require('path').join(dir, 'ngrok');
                fs.mkdirSync(cfgDir, { recursive: true });

                const yml = `version: "2"\nauthtoken: ${token}\n`;
                fs.writeFileSync(require('path').join(cfgDir, 'ngrok.yml'), yml, 'utf-8');

                console.log('[Tunnel] ngrok 配置完成');
                socket.emit('tunnel-setup-result', { success: true, message: 'ngrok 配置成功！下次启动隧道将使用 ngrok' });
                socket.emit('tunnel-check-result', checkTunnelReady());
            } catch (err) {
                socket.emit('tunnel-setup-result', { success: false, message: `配置失败: ${err.message}` });
            }
        });
        socket.on('tunnel-start', async (data) => {
            const { port = 25565, protocol = 'tcp' } = data || {};
            socket.emit('tunnel-status', { status: 'starting', message: '正在建立隧道...' });
            const result = await startTunnel(port, protocol);
            socket.emit('tunnel-start-result', result);
        });
        socket.on('tunnel-stop', async () => {
            socket.emit('tunnel-status', { status: 'stopping', message: '正在停止...' });
            socket.emit('tunnel-stop-result', await stopTunnel());
        });
        socket.on('tunnel-status-query', () => { socket.emit('tunnel-status-result', getTunnelStatus()); });

        // ===== DDNS 动态域名 =====
        socket.on('ddns-setup', async (data) => {
            const { domain, token } = data || {};
            const result = setupDDNS(domain, token);
            socket.emit('ddns-setup-result', result);
            if (result.success) {
                const status = getDDNSStatus();
                socket.emit('ddns-status', status);
            }
        });
        socket.on('ddns-status', () => { socket.emit('ddns-status', getDDNSStatus()); });
        socket.on('ddns-update', async () => {
            socket.emit('ddns-update-result', await updateDDNS(true));
        });

        // ===== 断开 =====
        socket.on('disconnect-all', () => closeConnection(socket.id));
        socket.on('disconnect', () => {
            closeConnection(socket.id);
            if (socket._lanScanner) { socket._lanScanner.stop(); socket._lanScanner = null; }
        });
    });
}

// ---- 端口自动切换启动 ----
const PORT = parseInt(process.env.PORT) || 3000;
const MAX_PORT = PORT + 10;

function tryPort(port) {
    return new Promise((resolve, reject) => {
        const srv = httpServer.listen(port, () => {
            setupIO(srv);
            resolve(port);
        });
        srv.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && port < MAX_PORT) {
                console.log(`⚠️  端口 ${port} 被占用 → 尝试 ${port + 1}`);
                srv.close();
                tryPort(port + 1).then(resolve).catch(reject);
            } else {
                reject(err);
            }
        });
    });
}

tryPort(PORT).then((actualPort) => {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     🎮 Minecraft 联机大厅已启动          ║');
    console.log(`║     地址: http://localhost:${actualPort}       ║`);
    console.log('║     服务器 Ping | LAN扫描 | UPnP | 隧道  ║');
    console.log('╚══════════════════════════════════════════╝');
    openBrowser(`http://localhost:${actualPort}/minecraft`);
}).catch((err) => {
    console.error('❌ 无法启动服务器:', err.message);
    console.log('\n按 Enter 键退出...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(1));
});
