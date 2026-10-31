# 南医大评课助手 · 独立版

不依赖 DSH 的绿色版：自带 Node 运行时和 Playwright，双击 `start.cmd` 就能用。

## 怎么用

**双击「南医大评课助手.exe」**（或桌面上的同名快捷方式）即可 —— 不会弹黑框，会自动打开操作界面。

**怎么退出（三种方式，都行）**：

1. 界面右上角「**退出程序**」按钮（会二次确认）
2. **右键任务栏右下角的托盘图标** → 「退出程序（停止服务）」
3. 双击桌面「**停止评课助手**」快捷方式（不开界面，直接停）

> 退出只停掉后台服务；**Windows 计划任务不受影响**，到点仍会自动评课。
> 托盘图标还有一个用途：双击它就是重新打开界面。

> 也可以双击 `start.cmd`（会留一个命令行窗口，关闭它就等于停止服务）

1. 双击后在浏览器打开的页面里操作
2. 第一次用先点「Token」页签 → **扫描 Token**，确认能拿到有效登录态
3. 「操作」页签 → **立即执行**（或先「试运行（不提交）」看流程）
4. 「定时」页签 → 设好时间 → **注册 Windows 计划任务**（关掉这个窗口也会照常跑）
5. 「评课程」页签 → 学期末点一次 **评价本学期课程**

## 目录说明

```
start.cmd              启动控制台并打开网页
run-now.cmd            不开控制台、直接命令行跑一轮（可加 --dry-run）
node/node.exe          自带的 Node 运行时（无需装 Node）
node_modules/          playwright-core（浏览器自动化）
browser.js             评课/评课程的核心流程
run-once.mjs           随堂评价入口（含 Token 自动续期、失败弹窗）
run-course.mjs         期末评课程入口
server.mjs             本地控制台（127.0.0.1:17320，只用 node:http）
ui.html                控制台页面
lib/config.mjs         配置读写（默认值与校验）
tools/wechat-token.ps1 微信浮窗自动换 Token
tools/notify.ps1       失败时弹置顶提醒窗
```

## 配置文件在哪

```
%LOCALAPPDATA%\smueval-bot\config.json
```

**和 DSH 插件共用同一份**，所以两边切换不用重新配。同目录还有：

| 文件 | 内容 |
|---|---|
| `last-run.json` | 最近一次随堂评价结果 |
| `last-course-run.json` | 最近一次评课程结果 |
| `runs.jsonl` | 历史记录（一行一次） |
| `run.log` | 运行日志 |
| `standalone-run.cmd` | 计划任务实际调用的批处理（自动生成） |

## 命令行用法

```
node\node.exe run-once.mjs                 # 立刻跑一轮
node\node.exe run-once.mjs --jitter        # 先随机等一会儿（像计划任务那样）
node\node.exe run-once.mjs --dry-run       # 只点不提交
node\node.exe run-once.mjs --check         # 只看配置
node\node.exe run-once.mjs --refresh-token # 只刷新 Token
node\node.exe run-once.mjs --test-notify   # 测试失败弹窗
node\node.exe run-course.mjs [--dry-run]   # 期末评课程
```

## 注意事项

- **需要本机已安装 Microsoft Edge**（或 Chrome）——自动化用的是真实浏览器，不是内置内核
- **计划任务和 DSH 插件共用任务名**（`smueval-bot-2030`）。在独立版里点「注册计划任务」会把它指向本目录；想换回 DSH，就在 DSH 面板里重新开关一次
- **Token 续期要操作微信窗口**：必须是已登录的桌面会话（锁屏无效），且电脑版微信的浮窗里要有「教学服务平台系统」（手机微信里从「南医大教学」→「本科」进教务系统 → 右上角「···」→ 浮窗，一次性设置）
- 把整个文件夹拷到别的 Windows 电脑上也能直接跑（前提是那台机器装了 Edge、有微信登录态）

## 和 DSH 插件版的区别

| | DSH 插件版 | 独立版 |
|---|---|---|
| 需要 DSH | 是 | **否** |
| 需要装 Node | 否（用 DSH 自带） | 否（自带） |
| 界面 | DSH 插件配置面板 | 本地网页 `127.0.0.1:17320` |
| 功能 | 全部 | 全部（随堂评/评课程/Token 续期/计划任务/失败弹窗） |
| 配置 | 同一份 `config.json` | 同一份 `config.json` |
