# 访客 - 人形监测系统

面向桌面场景的访客监听工具：按窗口标题选定目标窗口，周期截屏并做**人形检测**，支持系统提醒、历史查看、邮件通知。

优势：理论上可支持直播、监控、视频等各种可视窗口，不论软硬件厂商。手机窗口也可投屏到PC上来识别。
Advantage: In theory, it supports various visual windows such as live streams, surveillance feeds, and videos, regardless of software or hardware vendor; mobile screens can also be mirrored to a PC for recognition.

## 适用环境

- Windows 10/11（推荐，窗口置顶等能力按 Windows 设计）
- Python 3.9+
- Node.js 18+

## 快速开始

在 `imgListen` 目录执行：

```bash
npm install
py -3 -m pip install -r python\requirements.txt
```

启动：

```bash
npm run dev
或
点击start.bat 运行本应用
```

或直接双击 `start.bat`。

## 运行与配置

1. 在下拉列表中选择目标窗口标题。
2. 点击「开始监听」，目标窗口中出现人形时将收到系统提示、邮件提示（若有配置），并支持“查看历史”来看图片。
3. 点击「停止监听」，中止。
4. 按需设置：
   - 截屏分析间隔
   - 是否启用系统右下角弹窗
   - 邮件参数（可选）
   - 等

## 使用说明

- 「刷新窗口列表」：重新扫描当前桌面可选窗口。
- 「查看历史」：查看访客记录与截图。
- 顶部红色提醒可点击，点击后会直接打开历史页面。
- 若开启网页服务，可在本机访问：
  - `http://127.0.0.1:12000/`
  - `http://localhost:12000/`

## 常见问题

### 1) 启动失败：找不到 Python

确认命令可用：

```bash
py -3 --version
```

如使用自定义 Python，可设置环境变量 `PYTHON_EXE` 指向解释器路径。

### 2) 检测慢或首次等待较久

首次运行会初始化模型，可能需要几十秒；后续会明显变快。

### 3) 未检测到目标窗口

- 先点「刷新窗口列表」
- **确认目标窗口没有最小化/被关闭，没有被其它窗口遮挡**，如需可在设置里开启“被监控窗口置顶”功能


## 说明

- 本项目默认仅供本地使用与个人学习场景。
- License: MIT
