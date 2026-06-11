# 🌐 端口远程连接工具

图形化端口远程连接工具，支持 **TCP / UDP / HTTP** 协议调试，内置 **Minecraft 联机大厅** 和 **智能隧道穿透**。

## ✨ 功能

### 网络调试
- **TCP 客户端** — 连接远程服务器，发送/接收数据
- **UDP 客户端** — UDP 数据报收发
- **HTTP 请求** — 发送 GET/POST 请求，查看响应
- **TCP 监听** — 本地开启 TCP 服务，接收客户端连接
- **UDP 监听** — 本地开启 UDP 服务，接收数据报

### 🎮 Minecraft 联机
- **服务器探测** — 获取 Java 版服务器状态、在线人数、MOTD
- **批量 Ping** — 同时检测多个服务器
- **局域网扫描** — 自动发现局域网内的 Minecraft 游戏
- **UPnP 端口映射** — 自动配置路由器端口转发
- **一键加入** — 生成 `minecraft://` 直连链接

### 🔗 隧道穿透
- **ngrok** — 地址固定不变（需注册免费 token）
- **pinggy.io** — 零配置，开箱即用（60 分钟自动续期）
- **智能降级** — ngrok 不可用时自动切换到 pinggy

## 🚀 快速开始

```bash
# 安装依赖
npm install

# 启动服务
npm start
```

浏览器自动打开 `http://localhost:3000`

## 📁 项目结构

```
WEB/
├── server.js              # 主服务（Express + Socket.IO）
├── lib/
│   ├── tunnel.js          # 隧道穿透（ngrok + pinggy.io 双后端）
│   ├── mc-ping.js         # Minecraft 服务器 Ping 协议
│   ├── lan-scanner.js     # Minecraft 局域网扫描
│   └── upnp.js            # UPnP 路由器端口映射
├── public/
│   ├── index.html         # 主界面（网络调试工具）
│   └── minecraft.html     # Minecraft 联机大厅
└── package.json
```

## 🛠 技术栈

| 技术 | 用途 |
|------|------|
| Express | HTTP 服务 + 静态文件 |
| Socket.IO | 浏览器 ↔ 服务器实时通信 |
| Node.js `net` | TCP 客户端/服务端 |
| Node.js `dgram` | UDP 客户端/服务端 |
| SSH | pinggy.io 隧道 |
| ngrok | 固定地址隧道 |

## 📦 构建

```bash
npm run build        # 打包为 Windows 可执行文件
npm run build-all    # 打包 Windows + Linux + macOS
```

## 🔧 隧道配置

### ngrok（地址固定）
1. 注册 [ngrok 账号](https://dashboard.ngrok.com/signup)
2. 获取 authtoken
3. 运行 `ngrok config add-authtoken <你的token>`

### pinggy.io（零配置）
确认系统已安装 SSH 客户端即可自动使用。
