/**
 * UPnP / NAT-PMP 端口映射模块
 * 实现自动发现路由器、添加/删除端口映射
 * 支持 UPnP IGD (Internet Gateway Device) 协议
 *
 * 改进版 v2.0:
 * - 放宽 SSDP 设备过滤条件
 * - 增强 XML 解析兼容性
 * - 多次 SSDP 发现重试
 * - 更好的内网 IP 选取逻辑
 */

const dgram = require('dgram');
const http = require('http');

// SSDP 组播地址
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// SSDP 发现消息
const SSDP_DISCOVER = [
	'M-SEARCH * HTTP/1.1',
	`HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
	'MAN: "ssdp:discover"',
	'MX: 3',
	'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
	'',
	''
].join('\r\n');

/**
 * (简易) XML 解析 — 不引入额外依赖，用正则提取
 * 仅用于 UPnP 场景的基本 SOAP 响应解析
 */
function extractTag(xml, tagName) {
	const regex = new RegExp(`<${tagName}[^>]*>(.*?)</${tagName}>`, 's');
	const match = xml.match(regex);
	return match ? match[1] : null;
}

/**
 * SSDP 发现 UPnP 网关设备（单次尝试）
 * @param {number} timeout - 超时毫秒数
 * @returns {Promise<{location: string, usn: string, server: string}>}
 */
function discoverGatewayOnce(timeout = 3000) {
	return new Promise((resolve, reject) => {
		const socket = dgram.createSocket('udp4');
		const devices = [];
		let timer;

		socket.on('message', (msg) => {
			const response = msg.toString('utf-8');

			// 只处理 200 OK 响应
			if (!response.includes('200 OK')) return;

			const lines = response.split('\r\n');
			const device = {};

			for (const line of lines) {
				const colonIdx = line.indexOf(':');
				if (colonIdx > 0) {
					const key = line.substring(0, colonIdx).trim().toLowerCase();
					const value = line.substring(colonIdx + 1).trim();
					device[key] = value;
				}
			}

			if (!device.location) return;

			// 放宽过滤：location、usn、st、server 任一包含 IGD/Gateway 相关标识
			const upperLoc = (device.location || '').toUpperCase();
			const upperST = (device.st || '').toUpperCase();
			const upperUSN = (device.usn || '').toUpperCase();
			const upperServer = (device.server || '').toUpperCase();

			const isIGD = upperLoc.includes('IGD')
				|| upperST.includes('IGD')
				|| upperUSN.includes('IGD')
				|| upperServer.includes('IGD')
				|| upperLoc.includes('GATEWAY')
				|| upperST.includes('INTERNETGATEWAYDEVICE')
				|| upperLoc.includes(':1');

			if (isIGD) {
				console.log(`[UPnP] SSDP 发现候选设备: ${device.location} (ST: ${device.st})`);
				devices.push({
					location: device.location,
					usn: device.usn || '',
					server: device.server || '',
					st: device.st || ''
				});
			}
		});

		socket.on('listening', () => {
			// 发送 SSDP 发现
			socket.send(SSDP_DISCOVER, SSDP_PORT, SSDP_ADDR);
		});

		socket.on('error', (err) => {
			clearTimeout(timer);
			socket.close();
			reject(err);
		});

		socket.bind(() => {
			const addr = socket.address();
			console.log(`[UPnP] SSDP 发现已启动 (端口 ${addr.port})`);
		});

		timer = setTimeout(() => {
			socket.close();
			if (devices.length > 0) {
				resolve(devices[0]);
			} else {
				reject(new Error('未发现支持 UPnP 的路由器'));
			}
		}, timeout);
	});
}

/**
 * SSDP 发现 UPnP 网关设备（多次重试，提高成功率）
 * @param {number} totalTimeout - 总超时毫秒数
 * @returns {Promise<{location, usn, server}>}
 */
async function discoverGateway(totalTimeout = 8000) {
	const attempts = 3;
	const perAttempt = Math.floor(totalTimeout / attempts);

	let lastError = null;

	for (let i = 0; i < attempts; i++) {
		try {
			console.log(`[UPnP] SSDP 发现尝试 ${i + 1}/${attempts}...`);
			const device = await discoverGatewayOnce(perAttempt);
			console.log(`[UPnP] 发现成功: ${device.location}`);
			return device;
		} catch (err) {
			lastError = err;
			console.log(`[UPnP] 尝试 ${i + 1} 失败: ${err.message}`);
			// 短暂等待后重试
			if (i < attempts - 1) {
				await new Promise(r => setTimeout(r, 500));
			}
		}
	}

	throw lastError || new Error('多次尝试后仍未发现 UPnP 设备');
}

/**
 * HTTP GET 请求（用于 UPnP 场景）
 * @returns {Promise<{statusCode, body, headers}>}
 */
function httpGet(url, timeout = 5000) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const req = http.request({
			hostname: parsed.hostname,
			port: parsed.port || 80,
			path: parsed.pathname + parsed.search,
			method: 'GET',
			timeout: timeout
		}, (res) => {
			let body = '';
			res.on('data', chunk => body += chunk);
			res.on('end', () => resolve({ statusCode: res.statusCode, body, headers: res.headers }));
		});

		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('HTTP GET 超时')); });
		req.end();
	});
}

/**
 * SOAP POST 请求
 * @returns {Promise<{statusCode, body}>}
 */
function soapRequest(url, soapBody, soapAction, timeout = 8000) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
	<s:Body>
		${soapBody}
	</s:Body>
</s:Envelope>`;

		const req = http.request({
			hostname: parsed.hostname,
			port: parsed.port || 80,
			path: parsed.pathname + parsed.search,
			method: 'POST',
			timeout: timeout,
			headers: {
				'Content-Type': 'text/xml; charset="utf-8"',
				'Content-Length': Buffer.byteLength(body),
				'SOAPAction': `"${soapAction}"`,
			}
		}, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
		});

		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('SOAP 请求超时')); });
		req.write(body);
		req.end();
	});
}

/**
 * 获取 WAN IP
 * @returns {Promise<string>}
 */
async function getExternalIP(controlURL, serviceType) {
	const soapBody = `
		<u:GetExternalIPAddress xmlns:u="${serviceType}">
		</u:GetExternalIPAddress>
	`;

	const result = await soapRequest(controlURL, soapBody, `${serviceType}#GetExternalIPAddress`);
	const ip = extractTag(result.body, 'NewExternalIPAddress');
	return ip || '未知';
}

/**
 * 添加端口映射
 */
async function addPortMapping(options) {
	const {
		controlURL,
		serviceType,
		externalPort,
		internalPort,
		internalIP,
		description = 'Minecraft LAN',
		protocol = 'TCP',
		leaseDuration = 0
	} = options;

	const soapBody = `
		<u:AddPortMapping xmlns:u="${serviceType}">
			<NewRemoteHost></NewRemoteHost>
			<NewExternalPort>${externalPort}</NewExternalPort>
			<NewProtocol>${protocol}</NewProtocol>
			<NewInternalPort>${internalPort}</NewInternalPort>
			<NewInternalClient>${internalIP}</NewInternalClient>
			<NewEnabled>1</NewEnabled>
			<NewPortMappingDescription>${description}</NewPortMappingDescription>
			<NewLeaseDuration>${leaseDuration}</NewLeaseDuration>
		</u:AddPortMapping>
	`;

	const result = await soapRequest(controlURL, soapBody, `${serviceType}#AddPortMapping`);
	return result.statusCode === 200;
}

/**
 * 删除端口映射
 */
async function deletePortMapping(options) {
	const {
		controlURL,
		serviceType,
		externalPort,
		protocol = 'TCP'
	} = options;

	const soapBody = `
		<u:DeletePortMapping xmlns:u="${serviceType}">
			<NewRemoteHost></NewRemoteHost>
			<NewExternalPort>${externalPort}</NewExternalPort>
			<NewProtocol>${protocol}</NewProtocol>
		</u:DeletePortMapping>
	`;

	const result = await soapRequest(controlURL, soapBody, `${serviceType}#DeletePortMapping`);
	return result.statusCode === 200;
}

/**
 * 获取已有端口映射列表
 */
async function getPortMappings(controlURL, serviceType) {
	const mappings = [];
	let index = 0;

	while (true) {
		try {
			const soapBody = `
				<u:GetGenericPortMappingEntry xmlns:u="${serviceType}">
					<NewPortMappingIndex>${index}</NewPortMappingIndex>
				</u:GetGenericPortMappingEntry>
			`;

			const result = await soapRequest(controlURL, soapBody, `${serviceType}#GetGenericPortMappingEntry`);

			if (result.statusCode !== 200) break;

			const entry = {
				externalPort: extractTag(result.body, 'NewExternalPort'),
				internalPort: extractTag(result.body, 'NewInternalPort'),
				protocol: extractTag(result.body, 'NewProtocol'),
				internalClient: extractTag(result.body, 'NewInternalClient'),
				description: extractTag(result.body, 'NewPortMappingDescription'),
				enabled: extractTag(result.body, 'NewEnabled')
			};

			if (!entry.externalPort) break;

			mappings.push(entry);
			index++;
		} catch (e) {
			break;
		}
	}

	return mappings;
}

/**
 * 获取最佳内网 IP
 * 优先选择已连接的、有默认网关的接口
 */
function getBestInternalIP() {
	const os = require('os');
	const interfaces = os.networkInterfaces();

	// 优先级排序的候选 IP
	const candidates = [];

	for (const [name, addrs] of Object.entries(interfaces)) {
		for (const addr of addrs) {
			if (addr.family !== 'IPv4' || addr.internal) continue;

			// 优先级分数
			let priority = 0;

			// 以太网 > Wi-Fi > 其他
			const lowerName = name.toLowerCase();
			if (lowerName.includes('eth') || lowerName.includes('以太')) priority += 10;
			else if (lowerName.includes('wlan') || lowerName.includes('wi-fi') || lowerName.includes('wifi')) priority += 5;

			// 常见内网 IP 段优先（192.168.x.x, 10.x.x.x, 172.16-31.x.x）
			const parts = addr.address.split('.');
			if (parts[0] === '192' && parts[1] === '168') priority += 8;
			else if (parts[0] === '10') priority += 6;
			else if (parts[0] === '172' && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31) priority += 4;

			candidates.push({ address: addr.address, name, priority });
		}
	}

	// 按优先级降序排列
	candidates.sort((a, b) => b.priority - a.priority);

	if (candidates.length > 0) {
		console.log(`[UPnP] 选择内网 IP: ${candidates[0].address} (接口: ${candidates[0].name})`);
		return candidates[0].address;
	}

	return '127.0.0.1';
}

/**
 * 解析 WAN 连接控制 URL
 * 从设备描述 XML 中提取控制信息
 */
function parseWANConnectionInfo(xmlBody, baseURL) {
	const urlBase = extractTag(xmlBody, 'URLBase') || '';
	const basePath = urlBase || baseURL;

	// 匹配 service 块：<service>...</service>
	const serviceRegex = /<service>[\s\S]*?<\/service>/g;
	const services = xmlBody.match(serviceRegex) || [];

	for (const serviceXml of services) {
		const svcType = extractTag(serviceXml, 'serviceType') || '';
		const ctrlURL = extractTag(serviceXml, 'controlURL') || '';
		const scpdURL = extractTag(serviceXml, 'SCPDURL') || '';

		// 匹配 WANIPConnection 或 WANPPPConnection
		const upperType = svcType.toUpperCase();
		if ((upperType.includes('WANIPCONNECTION') || upperType.includes('WANPPPCONNECTION')) && ctrlURL) {
			let fullCtrlURL = ctrlURL;
			if (!fullCtrlURL.startsWith('http')) {
				fullCtrlURL = basePath + (fullCtrlURL.startsWith('/') ? '' : '/') + fullCtrlURL;
			}

			console.log(`[UPnP] 找到 WAN 服务: ${svcType}`);
			console.log(`[UPnP] Control URL: ${fullCtrlURL}`);

			return {
				serviceType: svcType,
				controlURL: fullCtrlURL
			};
		}
	}

	return null;
}

/**
 * 一键设置 Minecraft 端口映射
 * 自动发现路由器 → 添加 TCP 映射 → 返回外网地址
 *
 * @param {number} localPort - 本地 Minecraft 端口（默认 25565）
 * @returns {Promise<{success: boolean, externalIP: string, externalPort: number, message: string, detail?: string}>}
 */
async function setupMinecraftPortMapping(localPort = 25565) {
	try {
		// 1. 发现路由器（多次重试）
		console.log('[UPnP] 正在发现路由器（最多尝试3次）...');
		const gateway = await discoverGateway(8000);
		console.log(`[UPnP] 发现设备: ${gateway.location}`);

		// 2. 获取设备描述 XML
		const descResult = await httpGet(gateway.location, 5000);
		const baseURL = new URL(gateway.location);
		const basePath = `${baseURL.protocol}//${baseURL.hostname}:${baseURL.port || 80}`;

		// 3. 解析 WAN 连接信息
		const wanInfo = parseWANConnectionInfo(descResult.body, basePath);

		if (!wanInfo) {
			return {
				success: false,
				message: '路由器不支持 UPnP WAN 连接服务',
				detail: '未找到 WANIPConnection 或 WANPPPConnection 服务。请确认路由器已开启 UPnP 功能。'
			};
		}

		const { controlURL, serviceType } = wanInfo;

		// 4. 获取外网 IP
		let externalIP;
		try {
			externalIP = await getExternalIP(controlURL, serviceType);
			console.log(`[UPnP] 外网 IP: ${externalIP}`);
		} catch (e) {
			externalIP = '未知';
			console.log(`[UPnP] 获取外网 IP 失败: ${e.message}`);
		}

		// 5. 获取最佳内网 IP
		const internalIP = getBestInternalIP();

		// 6. 添加端口映射
		console.log(`[UPnP] 添加映射: ${externalIP}:${localPort} → ${internalIP}:${localPort}`);
		const mappingResult = await addPortMapping({
			controlURL,
			serviceType,
			externalPort: localPort,
			internalPort: localPort,
			internalIP: internalIP,
			description: 'Minecraft Java Edition (Port Connector)',
			protocol: 'TCP',
			leaseDuration: 0
		});

		if (!mappingResult) {
			return {
				success: false,
				message: '端口映射请求被路由器拒绝',
				detail: 'SOAP 请求未返回 200。可能原因：1) 端口已被占用 2) 路由器限制该端口范围 3) 需登录路由器管理页面手动添加'
			};
		}

		return {
			success: true,
			externalIP,
			externalPort: localPort,
			internalIP,
			internalPort: localPort,
			message: `映射成功! 外网地址: ${externalIP}:${localPort}`
		};

	} catch (err) {
		console.error(`[UPnP] 映射失败:`, err.message);
		return {
			success: false,
			message: `UPnP 映射失败: ${err.message}`,
			detail: getTroubleshootingHint(err.message)
		};
	}
}

/**
 * 根据错误信息提供排查建议
 */
function getTroubleshootingHint(errorMsg) {
	const lower = errorMsg.toLowerCase();

	if (lower.includes('未发现') || lower.includes('not found') || lower.includes('no device')) {
		return '排查建议:\n1. 确认路由器已开启 UPnP 功能（登录路由器管理页面 → 高级设置 → UPnP）\n2. 确认电脑与路由器在同一局域网\n3. 关闭 Windows 防火墙或允许 UDP 1900 端口\n4. 部分路由器需要重启后才能响应 SSDP';
	}
	if (lower.includes('超时') || lower.includes('timeout')) {
		return '排查建议:\n1. 路由器响应太慢，尝试增加超时时间\n2. 检查网络是否稳定\n3. 尝试关闭 VPN/代理后再试';
	}
	if (lower.includes('拒绝') || lower.includes('refused') || lower.includes('forbidden')) {
		return '排查建议:\n1. 登录路由器管理页面检查 UPnP 权限设置\n2. 尝试使用其他端口（如 25566）\n3. 某些路由器需要先在管理页面"允许"UPnP 操作';
	}
	if (lower.includes('eaddrinuse') || lower.includes('address in use')) {
		return '排查建议:\n1. 端口已被其他程序占用，请更换端口\n2. 使用 netstat -ano | findstr <端口> 查看占用程序';
	}

	return '排查建议:\n1. 确认路由器 UPnP 已开启\n2. 尝试重启路由器\n3. 如果路由器不支持 UPnP，请手动设置端口转发\n4. 检查是否处于校园网/公司网络等限制 UPnP 的网络环境';
}

module.exports = {
	discoverGateway,
	discoverGatewayOnce,
	addPortMapping,
	deletePortMapping,
	getPortMappings,
	getExternalIP,
	setupMinecraftPortMapping,
	getBestInternalIP
};
