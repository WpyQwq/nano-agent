# Nano Agent

一个 Windows 优先、本地优先的 Codex 风格智能体工作台 MVP。

## 当前已实现

- Codex 风格深色桌面 UI。
- 任务列表、欢迎页、任务对话和底部 Composer。
- 项目目录选择。
- OpenAI Chat Completions 兼容请求。
- Anthropic Messages 兼容请求。
- 演示模式，无 API Key 时也可以打开和体验界面。
- Windows 原生截图。
- Windows 原生鼠标移动、点击、滚轮和文本输入基础接口。
- 当前窗口列表。
- 电脑操控面板和危险点击确认。
- 本地设置保存。

## 启动

```powershell
cd D:\Nano
npm install
npm start
```

如果 Electron 二进制下载因网络原因超时，可先确认本机已存在：

```powershell
Test-Path .\node_modules\electron\dist\electron.exe
```

## 使用真实模型

打开“设置”，配置：

- 供应商：OpenAI 兼容或 Anthropic 兼容。
- 模型名称。
- API Base URL。
- API Key。

当前 MVP 在本地设置中保存配置。正式版本需要替换为 Windows Credential Manager 加密存储。

## 下一步开发重点

1. 独立感知层：Windows UI Automation、浏览器 DOM、OCR、可选视觉模型。
2. 统一 Computer Controller：observe、locate、checkPolicy、execute、verify。
3. 文件读取、搜索、Diff 和命令执行工具接入真实智能体循环。
4. Git 分支、提交、回滚和测试修复闭环。
5. MCP / 插件系统和后台任务。
