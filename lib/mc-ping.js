/**
 * Minecraft Java Edition 服务器 Ping 库
 * 实现 Server List Ping 协议，查询服务器状态、在线人数、MOTD 等
 */
const net = require('net');

// ==================== VarInt 编码/解码 ====================

/**
 * 从 Buffer 中读取 VarInt
 * @returns {{ value: number, bytesRead: number }}
 */
function readVarInt(buffer, offset = 0) {
    let value = 0;
    let position = 0;
    let currentByte;

    while (position < 5) {  // VarInt 最多 5 字节
        if (offset + position >= buffer.length) {
            throw new Error('VarInt 读取越界');
        }
        currentByte = buffer[offset + position];
        value |= (currentByte & 0x7F) << (position * 7);
        position++;

        if ((currentByte & 0x80) === 0) {
            break;
        }
    }

    if (position === 5) {
        // 5 字节 VarInt 的最后检查
        value |= (currentByte & 0x0F) << 28;
    }

    return { value, bytesRead: position };
}

/**
 * 将整数编码为 VarInt Buffer
 */
function writeVarInt(value) {
    const bytes = [];
    let val = value;

    do {
        let temp = val & 0x7F;
        val >>>= 7;
        if (val !== 0) {
            temp |= 0x80;
        }
        bytes.push(temp);
    } while (val !== 0);

    return Buffer.from(bytes);
}

/**
 * 写入带长度前缀的字符串
 */
function writeString(str) {
    const strBuf = Buffer.from(str, 'utf-8');
    const lenBuf = writeVarInt(strBuf.length);
    return Buffer.concat([lenBuf, strBuf]);
}

/**
 * 构建握手包
 * @param {string} host - 服务器地址
 * @param {number} port - 端口号
 * @param {number} protocolVersion - 协议版本（-1 表示自动探测）
 * @param {number} nextState - 下一状态（1=Status, 2=Login）
 */
function buildHandshakePacket(host, port, protocolVersion = -1, nextState = 1) {
    const packetId = writeVarInt(0x00);          // 握手包 ID
    const protoVer = writeVarInt(protocolVersion);
    const serverAddr = writeString(host);
    const serverPort = Buffer.alloc(2);
    serverPort.writeUInt16BE(port, 0);
    const next = writeVarInt(nextState);

    const data = Buffer.concat([packetId, protoVer, serverAddr, serverPort, next]);
    const length = writeVarInt(data.length);

    return Buffer.concat([length, data]);
}

/**
 * 构建状态请求包
 */
function buildStatusRequestPacket() {
    const data = writeVarInt(0x00);  // 请求包只包含 ID 0x00
    const length = writeVarInt(data.length);
    return Buffer.concat([length, data]);
}

/**
 * Ping Minecraft 服务器
 * @param {string} host - 服务器地址
 * @param {number} port - 端口号（默认 25565）
 * @param {number} timeout - 超时毫秒数
 * @returns {Promise<object>} 服务器信息对象
 */
function pingServer(host, port = 25565, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let responseData = Buffer.alloc(0);
        let timer;

        socket.setTimeout(timeout);

        socket.on('connect', () => {
            // 发送握手包
            const handshake = buildHandshakePacket(host, port, -1, 1);
            socket.write(handshake);

            // 发送状态请求包
            const statusReq = buildStatusRequestPacket();
            socket.write(statusReq);
        });

        socket.on('data', (data) => {
            responseData = Buffer.concat([responseData, data]);

            // 尝试解析响应
            try {
                // 读取包长度
                const { value: packetLength, bytesRead: lengthBytes } = readVarInt(responseData, 0);
                const totalExpected = lengthBytes + packetLength;

                if (responseData.length >= totalExpected) {
                    // 读取包 ID
                    const { value: packetId, bytesRead: idBytes } = readVarInt(responseData, lengthBytes);

                    if (packetId === 0x00) {
                        // 状态响应：读取 JSON 字符串长度和内容
                        const jsonStart = lengthBytes + idBytes;
                        const { value: jsonLength, bytesRead: jsonLenBytes } = readVarInt(responseData, jsonStart);
                        const jsonDataStart = jsonStart + jsonLenBytes;
                        const jsonStr = responseData.slice(jsonDataStart, jsonDataStart + jsonLength).toString('utf-8');

                        try {
                            const serverInfo = JSON.parse(jsonStr);
                            clearTimeout(timer);
                            socket.destroy();
                            resolve(parseServerInfo(serverInfo, host, port));
                            return;
                        } catch (parseErr) {
                            clearTimeout(timer);
                            socket.destroy();
                            reject(new Error(`JSON 解析失败: ${parseErr.message}`));
                            return;
                        }
                    }
                }
            } catch (e) {
                // 数据不完整，继续等待
                if (e.message === 'VarInt 读取越界') {
                    return; // 等待更多数据
                }
            }
        });

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error(`连接超时 (${timeout}ms)`));
        });

        socket.on('error', (err) => {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error(`连接失败: ${err.message}`));
        });

        socket.connect(port, host);

        // 兜底超时
        timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('Ping 超时'));
        }, timeout + 2000);
    });
}

/**
 * 解析并美化服务器信息
 */
function parseServerInfo(raw, host, port) {
    // 解析 MOTD（可能是字符串或复杂对象）
    let motd = '';
    if (typeof raw.description === 'string') {
        motd = raw.description;
    } else if (raw.description && raw.description.text) {
        motd = raw.description.text;
    } else if (raw.description && raw.description.extra) {
        motd = raw.description.extra.map(e => e.text || '').join('');
    }

    // 去除 Minecraft 颜色代码 (§x)
    motd = motd.replace(/§[0-9a-fk-or]/gi, '');

    // 玩家信息
    const players = {
        online: raw.players ? raw.players.online : 0,
        max: raw.players ? raw.players.max : 0,
        sample: raw.players && raw.players.sample
            ? raw.players.sample.map(p => ({ name: p.name, id: p.id }))
            : []
    };

    // 版本信息
    const version = {
        name: raw.version ? raw.version.name : '未知',
        protocol: raw.version ? raw.version.protocol : 0
    };

    return {
        host,
        port,
        online: true,
        version,
        players,
        motd: motd || '(无 MOTD)',
        favicon: raw.favicon || null,           // base64 PNG
        enforcesSecureChat: raw.enforcesSecureChat || false,
        previewsChat: raw.previewsChat || false,
        raw: raw
    };
}

/**
 * 快速 Ping（仅判断是否在线）
 * @returns {Promise<boolean>}
 */
async function pingQuick(host, port = 25565, timeout = 3000) {
    try {
        await pingServer(host, port, timeout);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    pingServer,
    pingQuick,
    readVarInt,
    writeVarInt
};
