/**
 * 隧道穿透模块 — 智能多后端自动隧道
 *
 * 后端优先级（自动降级）:
 *   Level 1: ngrok      — 地址固定不变，需注册免费账号
 *   Level 2: pinggy.io  — 零配置，60分钟自动续期（地址会变）
 *
 * 原理:
 *   ngrok:     ngrok tcp PORT  →  API 获取公网地址
 *   pinggy.io: ssh -R 0:localhost:PORT tcp@a.pinggy.io
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const SSH_TIMEOUT = 20000;
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';
const NGROK_POLL_MAX = 15;
const RENEW_BEFORE_MS = 3300000;  // 55分钟 (pinggy 60分钟有效期)

// ngrok 下载地址
const NGROK_DOWNLOAD = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip';
const NGROK_DIR = path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '.', 'port-connector', 'ngrok');

// ==================== 全局状态 ====================
let tunnelProcess = null;
let tunnelInfo = null;           // { public_url, local_port, backend, pid, startedAt, stable }
let renewTimer = null;
let onRenewCallback = null;

// ==================== plink 捆绑检测 ====================
function findBundledPlink() {
	const candidates = [];

	// Electron 打包: process.resourcesPath/lib/bin/plink.exe
	if (process.resourcesPath) {
		candidates.push(path.join(process.resourcesPath, 'lib', 'bin', 'plink.exe'));
	}

	// pkg 打包: 跟 exe 同级目录
	try {
		candidates.push(path.join(path.dirname(process.execPath), 'lib', 'bin', 'plink.exe'));
	} catch (e) { /* ignore */ }

	// 开发模式: __dirname = lib/
	candidates.push(path.join(__dirname, 'bin', 'plink.exe'));

	for (const p of candidates) {
		if (fs.existsSync(p)) {
			console.log(`[Tunnel] 找到捆绑 SSH: ${p}`);
			return p;
		}
	}
	return null;
}

// ==================== SSH 检测 ====================
function detectSSH() {
	const candidates = [];
	if (process.platform === 'win32') {
		try {
			const result = execSync('where ssh', { encoding: 'utf-8', timeout: 5000 }).trim();
			if (result) result.split('\n').forEach(p => { const c = p.trim(); if (c) candidates.push(c); });
		} catch (e) { /* ignore */ }
		candidates.push('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
	} else {
		try {
			const result = execSync('which ssh', { encoding: 'utf-8', timeout: 5000 }).trim();
			if (result) candidates.push(result);
		} catch (e) { /* ignore */ }
	}

	const seen = new Set();
	for (const sshPath of candidates.filter(p => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))) {
		try {
			const out = execSync(`"${sshPath}" -V 2>&1`, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
			const vMatch = out.match(/OpenSSH[_\s]([\d.]+)/i);
			if (vMatch) return { available: true, path: sshPath, version: vMatch[1], type: 'openssh' };
		} catch (e) {
			const errOut = (e.stderr || e.stdout || '').toString();
			const vMatch = errOut.match(/OpenSSH[_\s]([\d.]+)/i);
			if (vMatch) return { available: true, path: sshPath, version: vMatch[1], type: 'openssh' };
		}
	}

	// 系统 SSH 未找到 → 回退到捆绑的 plink.exe
	const plinkPath = findBundledPlink();
	if (plinkPath) {
		return { available: true, path: plinkPath, version: 'plink 0.84', type: 'plink' };
	}

	return { available: false, error: '未检测到 SSH 客户端 (系统未安装 OpenSSH，也未找到捆绑的 plink.exe)' };
}

// ==================== ngrok ====================

function findNgrok() {
	// 1. 检查自带的 ngrok
	const localExe = path.join(NGROK_DIR, 'ngrok.exe');
	if (fs.existsSync(localExe)) return { available: true, path: localExe, local: true };

	// 2. 检查 PATH
	try {
		const result = execSync('where ngrok', { encoding: 'utf-8', timeout: 5000 }).trim();
		if (result) return { available: true, path: result.split('\n')[0].trim(), local: false };
	} catch (e) { /* ignore */ }

	// 3. 检查常见位置
	const common = ['C:\\ngrok\\ngrok.exe'];
	for (const p of common) {
		if (fs.existsSync(p)) return { available: true, path: p, local: false };
	}

	return { available: false };
}

async function downloadNgrok() {
	console.log('[Tunnel] 正在下载 ngrok...');
	const ngrokExe = path.join(NGROK_DIR, 'ngrok.exe');
	if (fs.existsSync(ngrokExe)) {
		return { success: true, path: ngrokExe };
	}

	try {
		fs.mkdirSync(NGROK_DIR, { recursive: true });
		const zipPath = path.join(NGROK_DIR, 'ngrok.zip');

		// 下载
		await new Promise((resolve, reject) => {
			const { exec } = require('child_process');
			const psCmd = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${NGROK_DOWNLOAD}' -OutFile '${zipPath}'`;
			exec(`powershell -Command "${psCmd}"`, { timeout: 120000 }, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});

		// 解压
		execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${NGROK_DIR}' -Force"`, { timeout: 30000 });

		// 清理
		try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }

		if (fs.existsSync(ngrokExe)) {
			console.log('[Tunnel] ngrok 下载完成');
			return { success: true, path: ngrokExe };
		}
		return { success: false, error: '解压失败' };
	} catch (err) {
		return { success: false, error: err.message };
	}
}

async function checkNgrokAuth(ngrokPath) {
	try {
		const out = execSync(`"${ngrokPath}" config check 2>&1`, { encoding: 'utf-8', timeout: 3000, windowsHide: true });
		return { authenticated: !out.includes('not found') && !out.includes('ERROR') };
	} catch (e) {
		return { authenticated: false };
	}
}

function isNgrokReady() {
	const ngrok = findNgrok();
	if (!ngrok.available) return { ready: false, reason: 'not-installed' };
	try {
		const out = execSync(`"${ngrok.path}" config check 2>&1`, { encoding: 'utf-8', timeout: 3000, windowsHide: true });
		if (!out.includes('not found') && !out.includes('ERROR')) {
			return { ready: true, path: ngrok.path };
		}
		return { ready: false, reason: 'no-authtoken' };
	} catch (e) {
		return { ready: false, reason: 'check-failed', error: e.message };
	}
}

function fetchNgrokAPI() {
	return new Promise((resolve, reject) => {
		const req = http.get(NGROK_API, { timeout: 3000 }, (res) => {
			let body = '';
			res.on('data', c => body += c);
			res.on('end', () => {
				try {
					const data = JSON.parse(body);
					const tunnels = data.tunnels || [];
					const tcp = tunnels.find(t => t.proto === 'tcp');
					resolve(tcp || tunnels[0] || null);
				} catch (e) { reject(new Error('解析失败')); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
		req.end();
	});
}

async function waitForNgrok(maxRetries = NGROK_POLL_MAX) {
	for (let i = 0; i < maxRetries; i++) {
		await sleep(1000);
		try {
			const info = await fetchNgrokAPI();
			if (info?.public_url) return info;
		} catch (e) { /* still starting */ }
	}
	throw new Error('ngrok 启动超时');
}

async function startNgrokTunnel(port) {
	// 先找 ngrok
	let ngrok = findNgrok();

	// 没找到 → 自动下载
	if (!ngrok.available) {
		console.log('[Tunnel] ngrok 未安装，自动下载...');
		const dl = await downloadNgrok();
		if (!dl.success) {
			return { success: false, backend: 'ngrok', message: `ngrok 下载失败: ${dl.error}` };
		}
		ngrok = { available: true, path: dl.path, local: true };
	}

	// 检查认证
	const auth = await checkNgrokAuth(ngrok.path);
	if (!auth.authenticated) {
		return {
			success: false,
			backend: 'ngrok',
			message: 'ngrok 未配置 authtoken',
			detail: '请:\n1. 访问 https://dashboard.ngrok.com/signup 注册\n2. 复制你的 authtoken\n3. 在终端运行: ngrok config add-authtoken <你的token>'
		};
	}

	console.log(`[Tunnel] 启动 ngrok tcp ${port}...`);

	return new Promise((resolve) => {
		const proc = spawn(ngrok.path, ['tcp', String(port)], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});

		let startupError = '';
		proc.stderr?.on('data', (d) => {
			const t = d.toString();
			if (t.includes('authtoken') || t.includes('authentication')) startupError = 'ngrok 认证失败';
			else if (t.includes('limit') || t.includes('account')) startupError = 'ngrok 账户限制';
		});

		proc.on('error', (err) => {
			tunnelProcess = null;
			resolve({ success: false, backend: 'ngrok', message: `启动失败: ${err.message}` });
		});

		proc.on('exit', () => { tunnelProcess = null; tunnelInfo = null; });
		tunnelProcess = proc;

		waitForNgrok().then((info) => {
			const url = (info.public_url || '').replace(/^tcp:\/\//, '');
			tunnelInfo = { public_url: url, local_port: port, backend: 'ngrok', pid: proc?.pid, startedAt: Date.now(), stable: true };
			scheduleRenew();
			resolve({ success: true, public_url: url, local_port: port, backend: 'ngrok', stable: true, message: `ngrok 隧道就绪: ${url}` });
		}).catch((err) => {
			resolve({ success: false, backend: 'ngrok', message: startupError || err.message });
		});
	});
}

// ==================== pinggy.io ====================

function parseTunnelAddress(text) {
	const m = text.match(/tcp:\/\/(\S+\.pinggy\S+:\d+)/i);
	if (m) return { address: m[1], backend: 'pinggy.io' };
	const s = text.match(/from\s+(\S+serveo\S+:\d+)/i);
	if (s) return { address: s[1].replace(/^tcp:\/\//, ''), backend: 'serveo.net' };
	return null;
}

function startPinggyTunnel(localPort) {
	return new Promise((resolve) => {
		const ssh = detectSSH();
		if (!ssh.available) {
			resolve({ success: false, backend: 'pinggy.io', message: 'SSH 客户端不可用', detail: `系统SSH: ${ssh.error || '未检测到'}\n内置plink: ${findBundledPlink() || '未找到'}\n\n请安装 OpenSSH 客户端或重启程序` });
			return;
		}

		console.log(`[Tunnel] 启动 pinggy.io TCP 隧道 (端口 ${localPort}), 客户端: ${ssh.type}...`);

		const isPlink = ssh.type === 'plink';
		const args = isPlink
			? ['-P', '443', '-R', `0:localhost:${localPort}`, '-batch', 'tcp@a.pinggy.io']
			: ['-p', '443', '-R', `0:localhost:${localPort}`, '-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', 'tcp@a.pinggy.io'];

		let resolved = false, outputBuffer = '';

		try {
			tunnelProcess = spawn(ssh.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env } });
		} catch (err) {
			resolve({ success: false, backend: 'pinggy.io', message: `启动失败: ${err.message}`, detail: `SSH路径: ${ssh.path}\n类型: ${ssh.type}\n\n请重启程序或检查杀毒软件` });
			return;
		}

		const timeout = setTimeout(() => {
			if (!resolved) { resolved = true; killTunnelProcess(); resolve({ success: false, backend: 'pinggy.io', message: 'pinggy.io 连接超时 (20秒)' }); }
		}, SSH_TIMEOUT);

		const onData = (data) => {
			const text = data.toString('utf-8');
			outputBuffer += text;
			console.log(`[Tunnel] pinggy: ${text.trim()}`);
			if (!resolved) {
				const parsed = parseTunnelAddress(outputBuffer);
				if (parsed?.address) {
					resolved = true; clearTimeout(timeout);
					tunnelInfo = { public_url: parsed.address, local_port: localPort, backend: 'pinggy.io', pid: tunnelProcess?.pid, startedAt: Date.now(), stable: false };
					console.log(`[Tunnel] ✅ pinggy.io: ${parsed.address}`);
					scheduleRenew();
					resolve({ success: true, public_url: parsed.address, local_port: localPort, backend: 'pinggy.io', stable: false, message: `隧道已建立! ${parsed.address} → localhost:${localPort}` });
				}
			}
		};

		tunnelProcess.stdout?.on('data', onData);
		tunnelProcess.stderr?.on('data', onData);

		tunnelProcess.on('error', (err) => { if (!resolved) { resolved = true; clearTimeout(timeout); tunnelProcess = null; resolve({ success: false, backend: 'pinggy.io', message: `SSH 错误: ${err.message}` }); } });
		tunnelProcess.on('exit', (code) => {
			if (!resolved) { resolved = true; clearTimeout(timeout); tunnelProcess = null; resolve({ success: false, backend: 'pinggy.io', message: `SSH 断开 (exit ${code})`, detail: outputBuffer.trim() || '无错误信息' }); }
		});
	});
}

// ==================== 主导出函数 ====================

/**
 * 启动隧道 — 智能选择后端
 *   ngrok 已配置 token → 优先 ngrok（地址固定不变）
 *   ngrok 未配置     → 直接 pinggy（零配置，无需注册）
 */
async function startTunnel(port = 25565, protocol = 'tcp') {
	if (tunnelProcess) {
		console.log('[Tunnel] 停止已有隧道...');
		await stopTunnel();
	}

	// 快速预检：ngrok 是否完全就绪（已安装 + 已配置 token）
	const ngrokReady = isNgrokReady();
	console.log(`[Tunnel] ngrok 预检: ${ngrokReady.ready ? '已就绪 ✅' : ngrokReady.reason}`);

	if (ngrokReady.ready) {
		// ngrok 已配置 → 优先使用（地址固定不变）
		console.log('[Tunnel] 使用 ngrok (地址固定)...');
		const ngrokResult = await startNgrokTunnel(port);
		if (ngrokResult.success) return ngrokResult;
		console.log(`[Tunnel] ngrok 启动失败: ${ngrokResult.message}，降级到 pinggy...`);
	} else {
		console.log('[Tunnel] ngrok 未配置 token，直接使用 pinggy（零配置）...');
	}

	// pinggy.io — 零配置，60分钟自动续期
	const pinggyResult = await startPinggyTunnel(port);
	if (pinggyResult.success) return pinggyResult;

	// 全部失败
	const sshInfo = detectSSH();
	return {
		success: false,
		local_port: port,
		message: '隧道启动失败',
		detail: [
			`ngrok: ${ngrokReady.ready ? '启动失败' : '未配置 authtoken（需注册免费账号）'}`,
			`pinggy.io: ${pinggyResult.message}`,
			`SSH: ${sshInfo.available ? `v${sshInfo.version} ✓` : '未安装 ✗'}`,
			'',
			'💡 快速解决（二选一）:',
			'',
			'方案A — ngrok（地址固定，推荐）:',
			'1. 访问 https://dashboard.ngrok.com/signup 注册免费账号',
			'2. 复制 authtoken',
			'3. 终端运行: ngrok config add-authtoken <你的token>',
			'4. 回到这里重试',
			'',
			'方案B — pinggy（零配置，地址会变）:',
			'1. 确认 SSH 客户端已安装',
			'2. 确认网络能访问 a.pinggy.io:443',
			'3. 回到这里重试'
		].join('\n')
	};
}

async function stopTunnel() {
	if (!tunnelProcess) return { success: true, message: '没有运行中的隧道' };
	console.log(`[Tunnel] 停止 ${tunnelInfo?.backend || 'unknown'} 隧道...`);
	cancelRenew();
	killTunnelProcess();
	tunnelInfo = null;
	return { success: true, message: '隧道已停止' };
}

function killTunnelProcess() {
	if (!tunnelProcess) return;
	try {
		if (process.platform === 'win32') execSync(`taskkill /PID ${tunnelProcess.pid} /T /F 2>nul`, { stdio: 'ignore' });
		else tunnelProcess.kill('SIGTERM');
	} catch (e) { /* ignore */ }
	tunnelProcess = null;
}

function getTunnelStatus() {
	if (!tunnelProcess || tunnelProcess.killed) return { running: false, info: null };
	let remainingMs = 0;
	if (tunnelInfo?.startedAt && !tunnelInfo?.stable) remainingMs = Math.max(0, 3600000 - (Date.now() - tunnelInfo.startedAt));
	return { running: true, info: tunnelInfo, remainingMs, remainingMinutes: Math.ceil(remainingMs / 60000) };
}

function getTunnelAddress() {
	return tunnelInfo?.public_url?.replace(/^tcp:\/\//, '') || null;
}

function checkTunnelReady() {
	// 1. ngrok 已安装且已配置 token → 最佳方案
	const ngrokReady = isNgrokReady();
	if (ngrokReady.ready) {
		return { ready: true, backend: 'ngrok', detail: 'ngrok 已配置 ✅  地址永久固定' };
	}

	// 2. ngrok 已安装但未配置 token
	if (ngrokReady.reason === 'no-authtoken') {
		return { ready: true, backend: 'ngrok-need-auth', detail: 'ngrok 已安装但需配置 token（免费注册 30 秒）' };
	}

	// 3. pinggy (SSH) — 零配置方案
	const ssh = detectSSH();
	if (ssh.available) {
		const label = ssh.type === 'plink' ? `plink v${ssh.version}` : `OpenSSH v${ssh.version}`;
		return { ready: true, backend: 'pinggy.io', detail: `${label} 已就绪 (60分钟自动续期)` };
	}

	// 4. ngrok 可自动下载 (Windows)
	if (process.platform === 'win32') {
		return { ready: true, backend: 'ngrok-download', detail: '将自动下载 ngrok（需配置免费 token）' };
	}

	return { ready: false, backend: 'none', detail: '未检测到 SSH 或 ngrok' };
}

function onRenew(cb) { onRenewCallback = cb; }

async function autoRenew() {
	if (!tunnelProcess || !tunnelInfo) return;
	// ngrok 地址固定，不需要续期
	if (tunnelInfo.stable) { console.log('[Tunnel] ngrok 地址固定，跳过续期'); return; }

	const oldAddr = tunnelInfo.public_url;
	const port = tunnelInfo.local_port;
	console.log(`[Tunnel] ⏰ 自动续期... (旧: ${oldAddr})`);
	await stopTunnel();
	const result = await startTunnel(port);
	if (result.success) {
		console.log(`[Tunnel] ✅ 续期成功: ${result.public_url}`);
		if (onRenewCallback) onRenewCallback({ oldAddress: oldAddr, newAddress: result.public_url, backend: result.backend, localPort: port });
		scheduleRenew();
	} else {
		if (onRenewCallback) onRenewCallback({ oldAddress: oldAddr, newAddress: null, backend: tunnelInfo?.backend || 'unknown', localPort: port, error: result.message });
	}
}

function scheduleRenew() {
	if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
	// ngrok 地址固定，不需要续期
	if (tunnelProcess && tunnelInfo && !tunnelInfo.stable) {
		renewTimer = setTimeout(() => autoRenew(), RENEW_BEFORE_MS);
		console.log(`[Tunnel] 🔄 ${Math.round(RENEW_BEFORE_MS / 60000)} 分钟后自动续期`);
	}
}

function cancelRenew() {
	if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
	startTunnel, stopTunnel, getTunnelStatus, getTunnelAddress, checkTunnelReady, onRenew, scheduleRenew, isNgrokReady,
	detectSSH, findNgrok, downloadNgrok, startPinggyTunnel, startNgrokTunnel,
	checkNgrokInstalled: findNgrok, fetchNgrokTunnels: fetchNgrokAPI
};
