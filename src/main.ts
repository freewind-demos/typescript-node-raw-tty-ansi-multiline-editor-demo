import * as readline from "node:readline";
import process from "node:process";
import type { Key } from "node:readline";
import * as ansi from "./ansi.js";
import { createEditor } from "./editor.js";

const termW = () => process.stdout.columns ?? 80;
const termH = () => process.stdout.rows ?? 24;

type LogLine = string;

let log: LogLine[] = [];
const editor = createEditor();

/** 已发送过的正文（旧 → 新） */
let submitHistory: string[] = [];
/** null=编辑新内容；否则为 submitHistory 下标 */
let historyPos: number | null = null;
/** Ctrl+C 连按：0 正常；1 已提示再按退出 */
let ctrlCExitStage = 0;

function pushLog(block: string): void {
  for (const ln of block.split("\n")) log.push(ln);
  const max = Math.max(40, termH() * 6);
  if (log.length > max) log = log.slice(log.length - max);
}

function visualLen(s: string): number {
  let v = 0;
  for (const ch of s) v += /[\u0000-\u007f]/.test(ch) ? 1 : 2;
  return v;
}

function padToVisual(s: string, target: number): string {
  const v = visualLen(s);
  if (v >= target) return s;
  return s + " ".repeat(target - v);
}

function handleCommand(text: string): void {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower === "help" || lower === "?") {
    pushLog(
      [
        `${ansi.bold}可用命令${ansi.reset}（整段发送，可多行）：`,
        `  help / ?        本说明`,
        `  demo sgr        16 色 + 基本 SGR`,
        `  demo 256        256 色条`,
        `  demo truecolor  24bit 渐变`,
        `  demo styles     粗体/斜体/下划线/反显等`,
        `  demo cursor     光标移动演示`,
        `  clear           清空下方输出区`,
        `  （编辑）首行↑/末行↓ 切上一条/下一条历史；Ctrl+C 清空，空时连按提示后退出`,
        "",
      ].join("\n"),
    );
    return;
  }
  if (lower === "clear") {
    log = [];
    pushLog(`${ansi.dim}输出区已清空${ansi.reset}`);
    return;
  }
  if (lower === "demo sgr") {
    const row = Array.from({ length: 8 }, (_, i) => `${ansi.fg(i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7)}█${ansi.reset}`).join(
      "",
    );
    pushLog(`${ansi.bold}前景 30–37${ansi.reset}\n${row}`);
    return;
  }
  if (lower === "demo 256") {
    let s = `${ansi.bold}256 色（38;5;n）${ansi.reset}\n`;
    for (let i = 16; i < 52; i++) s += ansi.fg256(i) + "█" + ansi.reset;
    pushLog(s);
    return;
  }
  if (lower === "demo truecolor") {
    let s = `${ansi.bold}24bit（38;2;r;g;b）${ansi.reset}\n`;
    for (let x = 0; x < 48; x++) {
      const r = Math.round((x / 47) * 255);
      s += ansi.fgTrue(r, 80, 200) + "▓" + ansi.reset;
    }
    pushLog(s);
    return;
  }
  if (lower === "demo styles") {
    pushLog(
      [
        `${ansi.bold}bold${ansi.reset}  ${ansi.dim}dim${ansi.reset}  ${ansi.italic}italic${ansi.reset}  ${ansi.underline}underline${ansi.reset}`,
        `${ansi.strikethrough}strikethrough${ansi.reset}  ${ansi.inverse}inverse${ansi.reset}${ansi.reset}`,
      ].join("\n"),
    );
    return;
  }
  if (lower === "demo cursor") {
    pushLog(
      [
        `${ansi.bold}光标定位${ansi.reset}：ANSI 序列 ${ansi.dim}CSI row;col H${ansi.reset}（本程序里即 \\x1b[row;colH）。`,
        `全屏重绘时先 ${ansi.dim}\\x1b[H\\x1b[2J${ansi.reset} 清屏回左上角，再打印整块 UI，最后把光标移到输入处。`,
      ].join("\n"),
    );
    return;
  }
  const lines = text.split("\n").length;
  const chars = [...text].length;
  pushLog(
    `${ansi.fg(6)}回显${ansi.reset} 行=${lines} 字=${chars}\n${ansi.dim}${text.replaceAll("\n", "↵ ")}${ansi.reset}`,
  );
}

function redraw(): void {
  const w = termW();
  const h = termH();
  const headerH = 11;
  const inputH = Math.min(8, Math.max(3, h - headerH - 6));
  const outH = Math.max(2, h - headerH - inputH - 2);

  const buf = editor.lines;
  const cy = editor.cur.line;
  const cx = editor.cur.col;

  let startLine = 0;
  if (buf.length > inputH) {
    startLine = Math.min(
      Math.max(0, cy - Math.floor(inputH / 2)),
      buf.length - inputH,
    );
  }
  const absCy = cy - startLine;

  const last = log.slice(-outH);
  while (last.length < outH) last.unshift("");

  let s = ansi.hideCursor + ansi.home + ansi.clearScreen;

  s += `${ansi.bold}${ansi.fg(4)}TTY / ANSI 多行输入演示${ansi.reset}  ${ansi.dim}Ctrl+C 清空；输入空时再按提示退出${ansi.reset}\n`;
  s += `${ansi.dim}命令：${ansi.reset}${ansi.fg(2)}help${ansi.reset} ${ansi.fg(2)}demo sgr${ansi.reset} ${ansi.fg(2)}demo 256${ansi.reset} ${ansi.fg(2)}demo truecolor${ansi.reset} ${ansi.fg(2)}demo styles${ansi.reset} ${ansi.fg(2)}demo cursor${ansi.reset} ${ansi.fg(2)}clear${ansi.reset}\n`;
  s += `${ansi.dim}Enter=发送  Shift+Enter=换行  ↑↓=行内移动；首行↑/末行↓=上一条/下一条历史  Ctrl+C×3=清空→提示→退出${ansi.reset}\n`;
  s += `${ansi.dim}Delete 粘贴  Ctrl+A/E 行首/尾  Ctrl+J=换行备选${ansi.reset}\n`;
  s += "\n";

  for (let i = 0; i < outH; i++) {
    const line = last[i] ?? "";
    s += `${ansi.dim}│${ansi.reset}${line}${ansi.clearLineEnd}\n`;
  }

  s += `${ansi.dim}${"─".repeat(Math.min(w, 72))}${ansi.reset}\n`;

  const vis = buf.slice(startLine, startLine + inputH);
  const rows: string[] = [];
  for (let i = 0; i < inputH; i++) {
    const rowText = vis[i] ?? "";
    const mark = i === absCy ? `${ansi.bold}>${ansi.reset}` : " ";
    const innerW = Math.max(1, w - 3);
    const body = padToVisual(rowText, innerW);
    rows.push(
      ansi.inputZoneBg +
        ansi.inputZoneFg +
        mark +
        " " +
        body +
        ansi.reset +
        ansi.clearLineEnd,
    );
  }
  s += rows.join("\n") + "\n";

  const firstInputRow = h - inputH + 1;
  const cursorRow = firstInputRow + absCy;
  const rowStr = buf[cy] ?? "";
  const sliceLeft = rowStr.slice(0, cx);
  const prefixCols = 3;
  let col = prefixCols + Math.min(visualLen(sliceLeft), w - prefixCols);
  if (col < prefixCols) col = prefixCols;
  if (col > w) col = w;

  s += ansi.moveTo(cursorRow, col) + ansi.showCursor;
  process.stdout.write(s);
}

function onSubmit(): void {
  const text = editor.getText();
  if (!text.trim()) {
    editor.resetAfterSubmit();
    historyPos = null;
    redraw();
    return;
  }
  submitHistory.push(text);
  historyPos = null;
  ctrlCExitStage = 0;
  handleCommand(text);
  editor.resetAfterSubmit();
  redraw();
}

function inputHasChars(): boolean {
  return editor.getText().length > 0;
}

function resetExitHint(): void {
  ctrlCExitStage = 0;
}

function leaveHistoryBrowse(): void {
  historyPos = null;
}

function noteBufferMutation(): void {
  resetExitHint();
  leaveHistoryBrowse();
}

/** Ctrl+C：仅在 keypress 里处理；另挂空 SIGINT 防止 Node 默认直接退出 */
function handleCtrlC(): void {
  if (inputHasChars()) {
    editor.clear();
    resetExitHint();
    leaveHistoryBrowse();
    redraw();
    return;
  }
  if (ctrlCExitStage === 0) {
    ctrlCExitStage = 1;
    pushLog(
      `${ansi.fg(1)}Ctrl+C${ansi.reset}：${ansi.bold}再按一次 Ctrl+C 将退出程序。${ansi.reset}`,
    );
    redraw();
    return;
  }
  cleanup();
  process.exit(0);
}

function historyPrev(): void {
  if (submitHistory.length === 0) return;
  if (historyPos === null) {
    historyPos = submitHistory.length - 1;
  } else if (historyPos > 0) {
    historyPos--;
  } else {
    return;
  }
  resetExitHint();
  editor.loadFromString(submitHistory[historyPos] ?? "");
}

function historyNext(): void {
  if (historyPos === null) return;
  if (historyPos < submitHistory.length - 1) {
    historyPos++;
    resetExitHint();
    editor.loadFromString(submitHistory[historyPos] ?? "");
    return;
  }
  historyPos = null;
  resetExitHint();
  editor.clear();
}

function handleKey(_str: string | undefined, key: Key): boolean {
  if (key.ctrl && key.name === "c") {
    handleCtrlC();
    return true;
  }
  if (key.name === "escape") return true;

  if (key.ctrl && key.name === "a") {
    editor.moveLineStart();
    return true;
  }
  if (key.ctrl && key.name === "e") {
    editor.moveLineEnd();
    return true;
  }
  if (key.ctrl && key.name === "j") {
    editor.insertNewline();
    noteBufferMutation();
    return true;
  }

  if (key.name === "return" || key.name === "enter") {
    if (key.shift) {
      editor.insertNewline();
      noteBufferMutation();
    } else onSubmit();
    return true;
  }

  if (key.name === "up") {
    if (editor.cur.line > 0) editor.moveUp();
    else historyPrev();
    return true;
  }
  if (key.name === "down") {
    if (editor.cur.line < editor.lines.length - 1) editor.moveDown();
    else historyNext();
    return true;
  }
  if (key.name === "left") {
    editor.moveLeft();
    return true;
  }
  if (key.name === "right") {
    editor.moveRight();
    return true;
  }
  if (key.name === "backspace") {
    editor.backspace();
    noteBufferMutation();
    return true;
  }
  if (key.name === "delete" || key.name === "forwarddelete") {
    editor.deleteForward();
    noteBufferMutation();
    return true;
  }
  if (key.name === "tab") {
    editor.insertText("  ");
    noteBufferMutation();
    return true;
  }

  const seq = key.sequence ?? "";
  if (seq && !key.ctrl && !key.meta && key.name === undefined) {
    editor.insertText(seq);
    noteBufferMutation();
    return true;
  }

  if (_str && !key.ctrl && !key.meta) {
    if (key.name && ["return", "enter", "tab"].includes(key.name)) return true;
    editor.insertText(_str);
    noteBufferMutation();
    return true;
  }

  return true;
}

function cleanup(): void {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(ansi.showCursor + ansi.altScreenOff + ansi.reset + "\n");
}

function main(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("请在真实终端里运行：pnpm start\n");
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write(ansi.altScreenOn);
  process.on("SIGINT", () => {});

  pushLog(`${ansi.fg(3)}就绪。${ansi.reset} 输入 ${ansi.bold}help${ansi.reset} 查看命令。`);
  redraw();

  process.stdin.on("keypress", (str, key) => {
    if (!key) return;
    const cont = handleKey(str, key);
    if (!cont) {
      cleanup();
      process.exit(0);
    }
    redraw();
  });

  process.stdout.on("resize", () => redraw());
}

main();
