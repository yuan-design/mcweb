/**
 * 动态域名 (DDNS) 模块 — DuckDNS
 *
 * 原理：
 *   定期向 DuckDNS 上报本机外网 IP，让你的域名始终指向你的电脑。
 *   配合 UPnP 端口映射使用：朋友直接连 你的域名:端口 即可。
 *
 * 使用：
 *   1. 访问 duckdns.org 用 GitHub/Google 登录
 *   2. 创建一个子域名（如 mymc）
 *   3. 复制 token
 *   4. 填入下方一键配置
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

// 配置存储路径
const CONFIG_DIR = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir(), 'port-connector');
const CONFIG_FILE = path.join(CONFIG_DIR, 'ddns.json');

// DuckDNS API
const DUCKDNS_API = 'www.duckdns.org';
const UPDATE_INTERVAL = 300000; // 每 5 分钟更新一次

let config = { domain: '', token: '', enabled: false, lastIP: '', lastUpdate: 0 };
let updateTimer = null;
let onUpdateCallback = null;

// ==================== 配置读写 ====================

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
            config = { ...config, ...JSON.parse(raw) };
        }
    } catch (e) {
        console.log('[DDNS] 读取配置失败，使用默认');
    }
    return config;
}

function saveConfig() {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
        console.log('[DDNS] 保存配置失败:', e.message);
    }
}

// ==================== 获取外网 IP ====================

function getPublicIP() {
    return new Promise((resolve, reject) => {
        // 通过 STUN 服务器获取或使用公开 IP API
        const req = http.get('http://api.ipify.org', { timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve(body.trim()));
        });
        req.on('error', () => {
            // 备选
            const req2 = http.get('http://checkip.amazonaws.com', { timeout: 5000 }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => resolve(body.trim()));
            });
            req2.on('error', () => reject(new Error('无法获取外网 IP')));
        });
    });
}

// ==================== DuckDNS 更新 ====================

async function updateIP(force = false) {
    if (!config.enabled || !config.domain || !config.token) {
        return { success: false, message: 'DDNS 未配置' };
    }

    try {
        const ip = await getPublicIP();

        // 如果 IP 没变且不是强制更新，跳过
        if (!force && ip === config.lastIP) {
            console.log(`[DDNS] IP 未变 (${ip})，跳过更新`);
            return { success: true, ip, message: 'IP 未变化，无需更新', changed: false };
        }

        // 调用 DuckDNS API
        await new Promise((resolve, reject) => {
            const url = `/update?domains=${encodeURIComponent(config.domain)}&token=${encodeURIComponent(config.token)}&ip=${ip}&verbose=true`;
            const req = http.get({ hostname: DUCKDNS_API, path: url, timeout: 10000 }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    if (body.trim() === 'OK') resolve();
                    else reject(new Error(`DuckDNS 返回: ${body.trim()}`));
                });
            });
            req.on('error', reject);
        });

        config.lastIP = ip;
        config.lastUpdate = Date.now();
        saveConfig();

        console.log(`[DDNS] ✅ 更新成功: ${config.domain}.duckdns.org → ${ip}`);
        return { success: true, ip, domain: `${config.domain}.duckdns.org`, message: '域名已更新', changed: true };
    } catch (err) {
        console.log(`[DDNS] 更新失败: ${err.message}`);
        return { success: false, message: `更新失败: ${err.message}` };
    }
}

// ==================== 设置 ====================

function setup(domain, token) {
    config.domain = (domain || '').trim().replace('.duckdns.org', '');
    config.token = (token || '').trim();
    config.enabled = !!(config.domain && config.token);
    saveConfig();

    if (config.enabled) {
        console.log(`[DDNS] 已配置: ${config.domain}.duckdns.org`);
        startAutoUpdate();
        // 立即更新一次
        updateIP(true).then(result => {
            console.log(`[DDNS] 首次更新: ${result.message}`);
            if (onUpdateCallback) onUpdateCallback(result);
        });
    } else {
        stopAutoUpdate();
    }

    return {
        success: config.enabled,
        domain: config.enabled ? `${config.domain}.duckdns.org` : '',
        message: config.enabled ? 'DDNS 已配置' : '域名或 token 不能为空'
    };
}

function getStatus() {
    return {
        enabled: config.enabled,
        domain: config.enabled ? `${config.domain}.duckdns.org` : '',
        lastIP: config.lastIP,
        lastUpdate: config.lastUpdate,
        updating: !!updateTimer
    };
}

// ==================== 自动更新 ====================

function startAutoUpdate() {
    stopAutoUpdate();
    if (!config.enabled) return;
    updateTimer = setInterval(() => {
        updateIP().then(result => {
            if (result.changed && onUpdateCallback) onUpdateCallback(result);
        });
    }, UPDATE_INTERVAL);
    console.log(`[DDNS] 🔄 每 ${UPDATE_INTERVAL / 60000} 分钟自动更新`);
}

function stopAutoUpdate() {
    if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
}

function onUpdate(cb) { onUpdateCallback = cb; }

// ==================== 初始化 ====================

loadConfig();
if (config.enabled) {
    console.log(`[DDNS] 加载配置: ${config.domain}.duckdns.org`);
    startAutoUpdate();
}

module.exports = { setup, getStatus, updateIP, startAutoUpdate, stopAutoUpdate, onUpdate, getPublicIP };
