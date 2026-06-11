# MCLJ — Minecraft 联机工具

桌面版 Minecraft 联机助手，**双击即用**，无需安装任何环境。

## 📥 下载

👉 **[最新版下载](https://github.com/yuan-design/mcweb/releases/latest)**

下载 `MCLJ 1.x.x.exe`，双击运行即可。

## ✨ 功能

### 🎮 服务器管理
- **服务器 Ping** — 获取 Java 版服务器状态、在线人数、版本、MOTD
- **批量检测** — 同时检测多个服务器
- **一键加入** — 自动复制地址，粘贴到 Minecraft 直接连接
- **预设服务器** — 内置 Hypixel、2B2T 等知名服务器

### 📡 局域网联机
- **局域网扫描** — 自动发现同一网络下的 Minecraft 游戏
- **一键加入局域网游戏**

### 🔧 端口映射 (UPnP)
- **自动配置路由器** — 无需手动进路由器设置
- **一键映射** — 输入端口号点开始即可

### 🌐 动态域名 (DDNS)
- **永久免费域名** — 基于 DuckDNS，给你的电脑一个固定地址
- **自动更新** — IP 变化时自动刷新域名指向
- **朋友永远用同一个地址连接你**

### 🚇 隧道穿透
- **ngrok** — 地址固定不变（需注册免费 token）
- **pinggy.io** — 零配置直接使用
- **智能选择** — 已配 ngrok 则优先使用，否则自动用 pinggy

## 🚀 使用方法

### 普通人（直接使用）
1. 下载 `MCLJ 1.x.x.exe`
2. 双击打开
3. 选择需要的功能

### 开发者（从源码运行）
```bash
npm install
npm start    # 启动桌面应用
npm run dev  # 仅启动服务（浏览器访问）
```

## 📁 项目结构

```
├── electron-main.js        # Electron 桌面应用主进程
├── server.js               # Express + Socket.IO 服务端
├── lib/
│   ├── tunnel.js           # 隧道穿透（ngrok + pinggy.io）
│   ├── mc-ping.js          # Minecraft 服务器 Ping 协议
│   ├── lan-scanner.js      # 局域网游戏扫描
│   ├── upnp.js             # UPnP 路由器端口映射
│   └── ddns.js             # DuckDNS 动态域名
├── public/
│   ├── minecraft.html      # 联机大厅主界面
│   ├── tunnel.html         # 隧道穿透管理页面
│   └── socket.io.js        # Socket.IO 客户端
└── package.json
```

## 🛠 技术栈

| 技术 | 用途 |
|------|------|
| Electron | 桌面应用框架 |
| Express + Socket.IO | 本地服务 + 实时通信 |
| DuckDNS API | 免费动态域名 |
| ngrok / pinggy.io | 内网穿透 |

## 📦 构建

```bash
npm run build        # 打包为 Windows 便携版 exe
```

## 🔧 常见场景

### 场景一：和朋友远程联机（不同网络）
1. 打开 **端口映射** → 点 **开始映射**（UPnP）
2. 打开 **动态域名** → 注册 DuckDNS → 一键绑定
3. 把域名发给朋友 → 朋友在 Minecraft 直接连接中输入域名

### 场景二：朋友在同一 WiFi
1. 打开 **局域网扫描** → 自动发现游戏 → 加入

### 场景三：查看服务器状态
1. 打开 **服务器列表** → 添加或选择预设服务器 → 自动检测

### 场景四：UPnP 不可用时
1. 打开 **隧道穿透** → 启动隧道 → 把生成的地址发给朋友
