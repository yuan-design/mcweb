/**
 * Minecraft 局域网游戏发现模块
 * 通过 UDP 组播扫描局域网内的 Minecraft 游戏
 */

const dgram = require('dgram');
const os = require('os');

// Minecraft LAN 广播地址和端口
const MC_MULTICAST_ADDR = '224.0.2.60';
const MC_MULTICAST_PORT = 4445;

/**
 * 获取本机所有局域网 IP 地址
 * @returns {string[]} IP 地址列表
 */
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs) {
            // 排除内部地址和非 IPv4 地址
            if (addr.family === 'IPv4' && !addr.internal) {
                ips.push(addr.address);
            }
        }
    }

    return ips;
}

/**
 * 解析 Minecraft LAN 广播消息
 * @param {string} message - 原始广播消息
 * @returns {{ motd: string, port: number } | null}
 */
function parseLanMessage(message) {
    const motdMatch = message.match(/\[MOTD\](.*?)\[\/MOTD\]/);
    const portMatch = message.match(/\[AD\](\d+)\[\/AD\]/);

    if (!motdMatch || !portMatch) return null;

    // 去除 Minecraft 颜色代码
    const motd = motdMatch[1].replace(/§[0-9a-fk-or]/gi, '').trim();
    const port = parseInt(portMatch[1], 10);

    return { motd: motd || '(未命名世界)', port };
}

/**
 * 扫描局域网 Minecraft 游戏
 * @param {number} duration - 扫描持续时间（毫秒）
 * @returns {Promise<object[]>} 发现的游戏列表
 */
function scanLAN(duration = 5000) {
    return new Promise((resolve) => {
        const games = [];
        const gameMap = new Map();  // key: host:port 去重
        const localIPs = getLocalIPs();

        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        socket.on('message', (msg, rinfo) => {
            const message = msg.toString('utf-8');
            const parsed = parseLanMessage(message);

            if (!parsed) return;
            if (localIPs.includes(rinfo.address)) return;  // 排除自己

            const key = `${rinfo.address}:${parsed.port}`;
            if (gameMap.has(key)) return;  // 去重

            const game = {
                host: rinfo.address,
                port: parsed.port,
                motd: parsed.motd,
                hostname: rinfo.address,  // 可能需要 DNS 反查
                discoveredAt: new Date().toISOString()
            };

            gameMap.set(key, game);
            games.push(game);
        });

        socket.on('error', (err) => {
            // 忽略绑定错误（可能是端口被占用）
            console.log(`[LAN扫描] 警告: ${err.message}`);
        });

        socket.on('listening', () => {
            socket.setBroadcast(true);
            socket.setMulticastTTL(128);

            try {
                socket.addMembership(MC_MULTICAST_ADDR);
                console.log(`[LAN扫描] 已加入组播组 ${MC_MULTICAST_ADDR}:${MC_MULTICAST_PORT}`);
            } catch (e) {
                console.log(`[LAN扫描] 加入组播组失败: ${e.message}`);
            }
        });

        socket.bind(MC_MULTICAST_PORT, () => {
            console.log(`[LAN扫描] 正在监听 ${MC_MULTICAST_PORT}`);
        });

        // 定时结束扫描
        setTimeout(() => {
            try {
                socket.dropMembership(MC_MULTICAST_ADDR);
            } catch (e) {
                // 忽略
            }
            socket.close();
            resolve(games);
        }, duration);
    });
}

/**
 * 连续扫描（返回 EventEmitter 实时推送结果）
 */
const { EventEmitter } = require('events');

class LANScanner extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.scanning = false;
        this.localIPs = getLocalIPs();
        this.gameMap = new Map();
    }

    start() {
        if (this.scanning) return;
        this.scanning = true;
        this.gameMap.clear();
        this.localIPs = getLocalIPs();

        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('message', (msg, rinfo) => {
            const message = msg.toString('utf-8');
            const parsed = parseLanMessage(message);

            if (!parsed) return;
            if (this.localIPs.includes(rinfo.address)) return;

            const key = `${rinfo.address}:${parsed.port}`;
            if (this.gameMap.has(key)) return;

            const game = {
                host: rinfo.address,
                port: parsed.port,
                motd: parsed.motd,
                discoveredAt: new Date().toISOString()
            };

            this.gameMap.set(key, game);
            this.emit('found', game);
        });

        this.socket.on('error', (err) => {
            this.emit('error', err);
        });

        this.socket.on('listening', () => {
            this.socket.setBroadcast(true);
            this.socket.setMulticastTTL(128);
            try {
                this.socket.addMembership(MC_MULTICAST_ADDR);
            } catch (e) {
                this.emit('error', new Error(`加入组播失败: ${e.message}`));
            }
            this.emit('scanning');
        });

        this.socket.bind(MC_MULTICAST_PORT);
    }

    stop() {
        this.scanning = false;
        if (this.socket) {
            try {
                this.socket.dropMembership(MC_MULTICAST_ADDR);
            } catch (e) {
                // 忽略
            }
            this.socket.close();
            this.socket = null;
        }
        this.emit('stopped');
    }

    getGames() {
        return Array.from(this.gameMap.values());
    }
}

module.exports = { scanLAN, LANScanner, getLocalIPs, parseLanMessage };
