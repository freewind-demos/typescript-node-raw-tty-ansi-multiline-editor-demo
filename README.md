# Node Raw TTY 多行聊天式 CLI Demo

## 简介

这个 Demo 用 **Node.js 标准库**直接做一个聊天式终端界面，重点演示这些常见能力：

- raw mode 读键盘
- 多行输入框
- 上下左右编辑
- `Shift+Enter` 换行、`Enter` 发送
- `Ctrl+C` 有内容时清空、空输入时二次确认退出
- 历史输入切换
- 用户消息整块灰底
- 助手消息与系统提示分风格显示
- `git diff / patch` 彩色展示
- spinner / 状态行 / 重绘

不依赖 `ink`、`blessed`、`prompts`。代码重点放在“终端原理”和“最小可运行交互”。

## 快速开始

### 环境要求

- Node.js 18+，建议 20+
- `pnpm`
- 真实 TTY 终端

### 运行

```bash
pnpm install
pnpm start
```

## 键位

- `Enter`：发送当前输入
- `Shift+Enter`：插入换行
- `↑ / ↓ / ← / →`：移动光标
- `Home / End`：跳到当前行首尾
- `Ctrl+A / Ctrl+E`：跳到当前行首尾
- `Ctrl+C`：有内容时清空；空内容时第一次提示、第二次退出
- `Ctrl+L`：强制重绘

历史规则：

- 光标在第一行时按 `↑`，切到上一条输入历史
- 光标在最后一行时按 `↓`，切到下一条输入历史
- 回到历史末尾时，会恢复你进入历史前的草稿

## 内置命令

- `help`
- `clear`
- `demo all`
- `demo colors`
- `demo patch`
- `demo code`
- `demo status`

你也可以输入任意多行文本，程序会先显示 spinner，再给出模拟回复。

## 实现思路

### 1. Raw 模式收键

```ts
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
```

这样方向键、回车、退格、`Ctrl+C` 都能自己接管。

### 2. 多行编辑器自己维护状态

`src/editor.ts` 里维护：

```ts
lines: string[]
cur: { line: number; col: number }
```

所有编辑操作都只是修改这两个状态：

- 插入字符
- 插入换行
- Backspace 合并行
- Delete 合并下一行
- 上下左右移动

### 3. 渲染是单流 transcript

`src/main.ts` 现在不是固定上下分栏，而是更接近 Python REPL：

- 已发送内容按顺序一直往下长
- 当前草稿始终贴在最底部
- 草稿刷新时只擦掉“底部草稿区”，不会把上面的 transcript 做成固定面板

这样终端观感更像 Note / REPL，而不是聊天应用的双栏布局。

### 4. 消息块按类型分风格

- 用户消息：灰色标题 + 浅灰正文底色
- 助手消息：蓝青色标题 + 深灰正文
- 系统消息：弱化显示
- diff 块：按 `+ / - / @@ / 文件头` 分色

这是命令行程序里最常见的一类视觉分层。

### 5. spinner 用定时器驱动

发送后先进入 pending 状态：

```ts
spinnerTimer = setInterval(() => {
  spinnerIndex++;
  refreshScreen();
}, 80);
```

1 秒后停止 spinner，再输出模拟回复。这样能展示“请求处理中”的感觉。

## 文件说明

- [src/main.ts](./src/main.ts)：主状态机、渲染、命令路由、spinner
- [src/editor.ts](./src/editor.ts)：多行编辑缓冲
- [src/ansi.ts](./src/ansi.ts)：ANSI 样式和控制序列

## 验证

```bash
pnpm typecheck
pnpm start
```

## 注意事项

- 不同终端对 `Shift+Enter` 的原始序列处理不完全一致，所以代码里同时兼容 `key.shift` 和“`ESC` 开头、`CR/LF` 结尾”的 Enter 序列。
- 中文宽度这里用“ASCII 算 1，非 ASCII 算 2”的简化规则，足够做 demo，但不是完整 East Asian Width 实现。
- 这是演示性质 CLI，不做真实网络请求；回复是本地 mock。

## 完整讲解

这个 Demo 想证明一件事：命令行下做“像聊天窗口一样的交互”并不一定要上重型 TUI 框架。核心其实只有三层。

第一层是 **输入状态**。终端不会帮你维护多行缓冲，所以程序自己维护 `lines + cursor`。你按一次左箭头，不是“光标 magically 左移了”，而是内存里的 `col` 变了；你按一次回车，也不是系统自动提交，而是程序判断这次到底是“发送”还是“插入换行”。

第二层是 **渲染状态**。用户消息、助手消息、系统提示、diff patch，其实都只是“不同颜色和不同 padding 的几行字符串”。终端 UI 的本质不是组件树，而是“当前这一帧我要输出哪些带 ANSI 的文本”。

第三层是 **交互节奏**。真正好看的 CLI 往往不只是把字打出来，而是会有：

- pending 时的 spinner
- 清晰的状态行
- 明显区分发送方和接收方
- 对 diff、代码块、日志块做不同配色
- 能够恢复输入历史

这些东西放在 GUI 很普通，但在纯终端里同样可以做，而且做法并不复杂。这个仓库就是把这些基础能力都放进一个最小 TypeScript Node demo 里，方便你以后继续扩。
