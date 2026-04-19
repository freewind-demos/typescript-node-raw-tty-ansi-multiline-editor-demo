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

function pushAssistant(block: string): void {
  const parts = block.split("\n");
  const head = parts[0] ?? "";
  pushLog(`${ansi.fg(5)}程序${ansi.reset} ${head}`);
  for (let i = 1; i < parts.length; i++) {
    pushLog(`  ${ansi.dim}${parts[i] ?? ""}${ansi.reset}`);
  }
}

function handleCommand(text: string): void {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower === "help" || lower === "?") {
    pushAssistant(
      [
        `${ansi.bold}可用命令${ansi.reset}（整段发送，可多行）：`,
        `  help / ?        本说明`,
        `  demo sgr        16 色 + 基本 SGR`,
        `  demo 256        256 色条`,
        `  demo truecolor  24bit 渐变`,
        `  demo styles     粗体/斜体/下划线/反显等`,
        `  demo cursor     光标移动演示`,
        `  clear           清空对话记录`,
        `  （编辑）首行↑/末行↓ 切上一条/下一条历史；Ctrl+C 清空，空时连按提示后退出`,
        "",
      ].join("\n"),
    );
    return;
  }
  if (lower === "clear") {
    log = [];
    pushLog(`${ansi.dim}对话已清空${ansi.reset}`);
    return;
  }
  if (lower === "demo sgr") {
    const row = Array.from({ length: 8 }, (_, i) => `${ansi.fg(i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7)}█${ansi.reset}`).join(
      "",
    );
    pushAssistant(`${ansi.bold}前景 30–37${ansi.reset}\n${row}`);
    return;
  }
  if (lower === "demo 256") {
    let s = `${ansi.bold}256 色（38;5;n）${ansi.reset}\n`;
    for (let i = 16; i < 52; i++) s += ansi.fg256(i) + "█" + ansi.reset;
    pushAssistant(s);
    return;
  }
  if (lower === "demo truecolor") {
    let s = `${ansi.bold}24bit（38;2;r;g;b）${ansi.reset}\n`;
    for (let x = 0; x < 48; x++) {
      const r = Math.round((x / 47) * 255);
      s += ansi.fgTrue(r, 80, 200) + "▓" + ansi.reset;
    }
    pushAssistant(s);
    return;
  }
  if (lower === "demo styles") {
    pushAssistant(
      [
        `${ansi.bold}bold${ansi.reset}  ${ansi.dim}dim${ansi.reset}  ${ansi.italic}italic${ansi.reset}  ${ansi.underline}underline${ansi.reset}`,
        `${ansi.strikethrough}strikethrough${ansi.reset}  ${ansi.inverse}inverse${ansi.reset}${ansi.reset}`,
      ].join("\n"),
    );
    return;
  }
  if (lower === "demo cursor") {
    pushAssistant(
      [
        `${ansi.bold}光标定位${ansi.reset}：ANSI 序列 ${ansi.dim}CSI row;col H${ansi.reset}（本程序里即 \\x1b[row;colH）。`,
        `单流对话：${ansi.dim}log + 当前草稿${ansi.reset} 合成一列，自下而上滚动；光标只在草稿行。`,
      ].join("\n"),
    );
    return;
  }
  const lines = text.split("\n").length;
  const chars = [...text].length;
  pushAssistant(
    `${ansi.fg(6)}回显${ansi.reset} 行=${lines} 字=${chars}\n${ansi.dim}${text.replaceAll("\n", "↵ ")}${ansi.reset}`,
  );
}

/** 当前草稿行并入对话流（前缀两列：光标行 `>`，其余 `·`） */
function draftLinesForStream(): string[] {
  return editor.lines.map((row, i) => {
    const mark =
      i === editor.cur.line
        ? `${ansi.fg(4)}>${ansi.reset}`
        : `${ansi.dim}·${ansi.reset}`;
    return `${mark} ${row}`;
  });
}

function redraw(): void {
  const w = termW();
  const h = termH();
  const headerRows = 1;
  const bodyH = Math.max(3, h - headerRows);

  const buf = editor.lines;
  const cy = editor.cur.line;
  const cx = editor.cur.col;

  const draftVis = draftLinesForStream();
  const merged: string[] = [...log, ...draftVis];
  const cursorMerged = log.length + cy;

  let start = Math.max(0, merged.length - bodyH);
  if (cursorMerged < start) start = cursorMerged;
  if (cursorMerged >= start + bodyH) start = cursorMerged - bodyH + 1;
  start = Math.max(0, Math.min(start, Math.max(0, merged.length - bodyH)));

  const slice = merged.slice(start, start + bodyH);
  const padTop = bodyH - slice.length;
  const vis: string[] = [...Array.from({ length: padTop }, () => ""), ...slice];

  let s = ansi.hideCursor + ansi.home + ansi.clearScreen;

  s += `${ansi.bold}${ansi.fg(4)}对话式 TTY${ansi.reset} ${ansi.dim}Enter 发送 · Shift+Enter 换行 · help · 首行↑/末行↓ 历史 · Ctrl+C 清空→空时再按退出${ansi.reset}${ansi.clearLineEnd}\n`;

  for (const line of vis) {
    s += line + ansi.clearLineEnd + "\n";
  }

  const rel = padTop + (cursorMerged - start);
  const cursorRow = headerRows + 1 + rel;
  const rowStr = buf[cy] ?? "";
  const sliceLeft = rowStr.slice(0, cx);
  const prefixCols = 3;
  let col = prefixCols + Math.min(visualLen(sliceLeft), w - prefixCols);
  if (col < prefixCols) col = prefixCols;
  if (col > w) col = w;

  s += ansi.moveTo(cursorRow, col) + ansi.showCursor;
  process.stdout.write(s);
}

function pushUserTurn(text: string): void {
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const head = parts[0] ?? "";
  pushLog(`${ansi.bold}你${ansi.reset} ${head}`);
  for (let i = 1; i < parts.length; i++) {
    pushLog(`${ansi.dim}  ${parts[i] ?? ""}${ansi.reset}`);
  }
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
  pushUserTurn(text);
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
