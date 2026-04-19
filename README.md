# Node 终端 Raw 模式 + ANSI 多行输入演示

## 简介

用 **Node.js 标准库**（`readline.emitKeypressEvents` + `stdin.setRawMode`）读按键，用 **ANSI 转义序列** 上色，在内存里维护 **多行缓冲** 与 **光标**，**单流对话**全屏重绘。不引入 `blessed` / `ink` / `prompts`，便于看清「终端里交互 UI」的最小原理。

## 快速开始

### 环境要求

- Node.js 18+（建议 20+）
- 真实 TTY（macOS Terminal、iTerm2、Windows Terminal、Linux 控制台等；IDE 集成终端多数可用）

### 运行

```bash
cd typescript-node-raw-tty-ansi-multiline-editor-demo
pnpm install
pnpm start
```

退出：**草稿为空时**连按两次 `Ctrl+C`（第一次仅提示，第二次退出）。草稿里还有字时，第一次 `Ctrl+C` 会**清空草稿**并取消退出提示。

## 概念讲解

### 第一部分：TTY 为什么要 Raw 模式

默认情况下，终端驱动会帮你处理一行输入（回显、退格、按 Enter 才交给程序）。要做「方向键移动光标、Shift+Enter 换行、整块发送」，需要让 stdin 进入 **raw（cbreak）** 模式：

```ts
process.stdin.setRawMode(true);
```

这样每次按键会尽快以字节流形式到达你的进程，而不是攒成一行。

### 第二部分：如何把按键变成「键名」

手写解析 `\x1b[A`（上箭头）等工作量大。Node 自带：

```ts
import * as readline from "node:readline";

readline.emitKeypressEvents(process.stdin);
```

之后监听：

```ts
process.stdin.on("keypress", (str, key) => {
  // key.name: 'up' | 'return' | 'backspace' | ...
  // key.shift / key.ctrl / key.meta
  // str: 可打印字符或粘贴块的一部分
});
```

本 Demo 用 `key.shift` 区分 **Shift+Enter**（插入换行）与普通 **Enter**（提交整段）。

### 第三部分：ANSI 颜色与样式（SGR）

以 `\x1b[` 开头、`m` 结尾的 **SGR** 控制前景/背景、粗体、下划线等。示例（原理与代码中一致）：

```ts
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const fgRed = "\x1b[31m";
const bg256 = (n: number) => `\x1b[48;5;${n}m`; // 256 色背景
```

**256 色**：`38;5;n` 前景、`48;5;n` 背景。

**24bit（truecolor）**：`38;2;r;g;b` / `48;2;r;g;b`。

### 第四部分：单流「对话」排版

**历史消息**（`log`）与 **正在输入的草稿**（`editor.lines`）拼成**同一列**，从上到下就是时间顺序；终端高度不够时从**底部往上裁**（`slice` + 顶部留白），新内容始终在视口下方堆积。草稿每一行前加 `>`（光标所在行）或 `·`（其它行），与上面的 `你` / `程序` 前缀同一套「往下读」的节奏。行尾仍用 **清除到行尾** 避免残影：

```ts
const clearLineEnd = "\x1b[K";
```

### 第五部分：多行缓冲与光标

与 readline 无关，自己维护：

```ts
const lines: string[]; // 每一行一个字符串
let curLine: number;
let curCol: number;
```

- **左/右**：在同一行内移动 `curCol`；到行尾再右则跳到下一行行首。
- **上/下**：在多行内移动光标；列号夹到目标行长度。若光标已在**第一行**再按 **↑**，则取出**上一条已发送历史**替换当前缓冲；在**最后一行**按 **↓**，在浏览历史时切到**下一条**，到末尾则回到空白新输入。
- **Backspace**：删前一个字符；在行首则合并上一行。
- **Delete**：删当前字符；在行尾则合并下一行。
- **粘贴**：`keypress` 可能一次带上多字符甚至含换行，直接 `insertText` 按字符与 `\n` 拆开即可。

### 第六部分：REPL 式重绘（不抢整屏）

与「全屏 TUI」不同，本 Demo **不用** `\x1b[2J` 清整屏、**不用**备用屏 `\x1b[?1049h`：正文像 `python` / `node` 一样用普通 `\n` 往下长，留在 shell 的滚动历史里。

多行草稿每次更新时：

1. `\x1b[?25l` 隐藏光标（减轻闪烁）。
2. 若上次已画出 `prevDraftLines` 行草稿，则 `\x1b[nA` 上移 `n` 行到草稿块起点，再 `\x1b[0J` 从该处清到屏幕末尾（擦掉旧草稿及光标下方的空行）。
3. 按当前缓冲把草稿行重新 `write` 出来（行尾可加 `\x1b[K` 避免残影）。
4. 用 `\x1b[nA\r` 与 `\x1b[nC` 把光标落到当前 `(行, 列)`（相对移动，依赖「光标始终在草稿块最后一行之下」这一不变量）。

退出时只 **关 raw、补一行换行**，不强制关备用屏（因为从未打开）。

## 完整示例

下面是与本仓库同思路的「最小骨架」（省略与 Demo 完全相同的错误处理，仅保留主干）：

```ts
import * as readline from "node:readline";
import process from "node:process";

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

let line = "";

process.stdin.on("keypress", (str, key) => {
  if (key.ctrl && key.name === "c") {
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  if (key.name === "return") {
    process.stdout.write("\n提交: " + line + "\n");
    line = "";
    return;
  }
  if (key.name === "backspace") {
    line = line.slice(0, -1);
    return;
  }
  if (str && !key.ctrl) line += str;
  process.stdout.write("\r\x1b[K\x1b[32m" + line + "\x1b[0m");
});
```

本仓库在此基础上扩展为多行草稿、对话流与命令演示。

## 程序里内置的命令

启动后顶部有简短提示。把下面词放在**整段输入**里（可多行），按 **Enter** 发送：

- `help`：命令说明  
- `demo sgr`：16 色条  
- `demo 256`：256 色示例  
- `demo truecolor`：24bit 渐变  
- `demo styles`：粗体、斜体、下划线、反显等  
- `demo cursor`：REPL 式滚动与草稿重绘说明  
- `clear`：清空内存中的对话记录（已滚出屏的终端历史不会消失）  
- 其它任意文本：回显行数与字数  

## 注意事项

- **Shift+Enter** 依赖终端把修饰键信息传给 Node；若你终端里 Shift+Enter 与普通 Enter 字节完全相同，则无法用 shift 区分。此时请用 **Ctrl+J**（ASCII LF）作为换行备选（本程序已支持）。
- **宽字符**（中文等）在「列对齐」里用「宽=2、ASCII=1」的粗估；极端排版以真实终端为准。
- 若在非 TTY 管道里运行，程序会拒绝启动并提示到真实终端执行。

## 完整讲解（中文）

终端本质上是一个「字符网格」：程序往 stdout 写字节，终端按当前状态去画字、上色、移动光标。平时用的「一行输入」，是终端驱动在 **cooked** 模式下帮你做了回显和编辑。一旦进入 **raw**，这些都要自己做：读到什么字节、是否代表方向键、是否代表粘贴，都由程序决定。

ANSI 序列是一小段以 ESC（`\x1b`）开头的文本，嵌在普通输出里。终端看到它们就会改「墨水颜色」「背景色」「光标位置」，而不是把这些字符显示成乱码（在支持 ANSI 的终端里）。所以「彩色 CLI」并不是魔法，只是输出里夹了人类看不见的控制码。

多行编辑的关键是 **状态机**：内存里放好多行字符串和一个 `(行, 列)` 光标。键盘事件只改这个状态，改完再把「整块界面」画一遍。听起来笨，但这是无数 TUI 的真实做法；库只是帮你封装了绘制与按键解析。

单流对话把**已打印正文**和**当前草稿**接在同一条时间线上：新内容一律 `stdout.write` + 换行往下接；终端窗口不够高时由终端自己滚，本程序不再做「裁视口」式的假滚动。

你按 Enter 时，本 Demo 把当前缓冲拼成一个大字符串交给命令处理或回显；按 Shift+Enter（若终端支持）或 Ctrl+J 时，只在缓冲里插入换行，不提交。粘贴时，终端通常一次性塞入许多字符，有的还带换行；`emitKeypressEvents` 会尽量拆成事件，程序把这些字符按顺序写进缓冲即可。

**Ctrl+C** 在类 Unix 上还会触发 **SIGINT**；本 Demo 在 `keypress` 里识别 `Ctrl+C` 做「有草稿先清空 → 空时第一次提示 → 再按一次才真正 `exit`」，并额外挂一个**空的** `SIGINT` 监听，避免 Node 默认一按就退出（与 `keypress` 重复计数的问题）。**↑/↓ 与历史**：缓冲内先按行移动；光标在**第一行**再按 **↑**、在**最后一行**再按 **↓** 才在历史数组里前后翻。任意**改字**（插入、删除、换行等）会退出「历史浏览态」。

退出前仍会 **关闭 raw、恢复光标并换行**，避免提示符和最后一行草稿粘在同一行。
