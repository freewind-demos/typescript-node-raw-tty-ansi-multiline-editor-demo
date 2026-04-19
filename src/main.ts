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

/** 上次画在屏幕上的草稿行数（用于上移擦除） */
let prevDraftLines = 0;

/**
 * placeDraftCursor 会把光标移进草稿行；下次若仍从「行内」做 nA，会误进 transcript 被 0J 吃掉。
 * 在草稿最后一行之下用 \\x1b[s 存锚点，重画/插正文前 \\x1b[u 回到该点再 nA。
 */
let draftAnchorSaved = false;

/** >0 时 appendTranscriptBlock 末尾不立刻 refresh（给 onSubmit 等批处理） */
let draftRefreshBatchDepth = 0;

let submitHistory: string[] = [];
let historyPos: number | null = null;
let ctrlCExitStage = 0;

function trimLogMemory(): void {
  const max = Math.max(80, termH() * 8);
  if (log.length > max) log = log.slice(log.length - max);
}

/** 回到「草稿块起点」再擦掉草稿（光标须在块下或已 u 回锚点） */
function moveToDraftEraseAnchor(): void {
  const out = process.stdout;
  if (draftAnchorSaved) out.write("\x1b[u");
  if (prevDraftLines > 0) {
    out.write(`\x1b[${prevDraftLines}A\x1b[0J`);
    prevDraftLines = 0;
  }
}

/** 先擦掉当前草稿，再追加多行正文（像 python / node REPL 一样往下长） */
function appendTranscriptBlock(block: string): void {
  const out = process.stdout;
  moveToDraftEraseAnchor();
  const lines = block.split("\n");
  for (const ln of lines) {
    log.push(ln);
    out.write(ln + ansi.clearLineEnd + "\n");
  }
  trimLogMemory();
  draftAnchorSaved = false;
  if (draftRefreshBatchDepth === 0) refreshDraft();
}

function pushLog(block: string): void {
  appendTranscriptBlock(block);
}

function beginDraftRefreshBatch(): void {
  draftRefreshBatchDepth++;
}

function endDraftRefreshBatch(): void {
  draftRefreshBatchDepth = Math.max(0, draftRefreshBatchDepth - 1);
  if (draftRefreshBatchDepth === 0) refreshDraft();
}

function visualLen(s: string): number {
  let v = 0;
  for (const ch of s) v += /[\u0000-\u007f]/.test(ch) ? 1 : 2;
  return v;
}

function pushAssistant(block: string): void {
  const parts = block.split("\n");
  const lines: string[] = [
    `${ansi.fg(5)}程序${ansi.reset} ${parts[0] ?? ""}`,
  ];
  for (let i = 1; i < parts.length; i++) {
    lines.push(`  ${ansi.dim}${parts[i] ?? ""}${ansi.reset}`);
  }
  pushLog(lines.join("\n"));
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
        `  demo cursor     滚动与草稿重绘说明`,
        `  clear           清空对话记录（仅内存）`,
        `  Shift+Enter    插入换行；Enter 发送整段`,
        `  （编辑）首行↑/末行↓ 历史；Ctrl+C 清空草稿，空时再按提示退出`,
        "",
      ].join("\n"),
    );
    return;
  }
  if (lower === "clear") {
    log = [];
    pushLog(`${ansi.dim}—— 对话记录已清空（内存；上方终端历史仍在）——${ansi.reset}`);
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
        `${ansi.bold}REPL 式滚动${ansi.reset}：不启用备用屏、不用 \\x1b[2J 清整屏；正文用普通换行往下长。`,
        `多行草稿：${ansi.dim}每次先 \\x1b[u 回到草稿块下的锚点（\\x1b[s 存的），再 nA+\\x1b[0J 擦掉草稿，避免从行内 nA 误伤上面的 transcript。${ansi.reset}`,
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

/** 草稿行：纯 ASCII 前缀，便于算光标列（与 python 提示符类似） */
function draftLinesForStream(): string[] {
  return editor.lines.map((row, i) => {
    const mark = i === editor.cur.line ? "> " : "· ";
    return `${mark}${row}`;
  });
}

function placeDraftCursor(nLines: number, cy: number, cx: number, rowStr: string): void {
  const out = process.stdout;
  const w = termW();
  const up = nLines - cy;
  out.write(`\x1b[${up}A\r`);
  const v = Math.min(visualLen(rowStr.slice(0, cx)), Math.max(0, w - 4));
  const col1 = 3 + v;
  if (col1 > 1) out.write(`\x1b[${col1 - 1}C`);
}

function refreshDraft(): void {
  const out = process.stdout;
  const lines = draftLinesForStream();
  const n = lines.length;
  const cy = editor.cur.line;
  const cx = editor.cur.col;
  const rowStr = editor.lines[cy] ?? "";

  out.write(ansi.hideCursor);
  moveToDraftEraseAnchor();
  for (const line of lines) {
    out.write(line + ansi.clearLineEnd + "\n");
  }
  prevDraftLines = n;
  out.write("\x1b[s");
  placeDraftCursor(n, cy, cx, rowStr);
  out.write(ansi.showCursor);
  draftAnchorSaved = true;
}

function pushUserTurn(text: string): void {
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const head = parts[0] ?? "";
  const lines: string[] = [`${ansi.bold}你${ansi.reset} ${head}`];
  for (let i = 1; i < parts.length; i++) {
    lines.push(`${ansi.dim}  ${parts[i] ?? ""}${ansi.reset}`);
  }
  pushLog(lines.join("\n"));
}

function onSubmit(): void {
  const text = editor.getText();
  if (!text.trim()) {
    editor.resetAfterSubmit();
    historyPos = null;
    refreshDraft();
    return;
  }
  submitHistory.push(text);
  historyPos = null;
  ctrlCExitStage = 0;
  beginDraftRefreshBatch();
  pushUserTurn(text);
  handleCommand(text);
  editor.resetAfterSubmit();
  endDraftRefreshBatch();
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

function handleCtrlC(): void {
  if (inputHasChars()) {
    editor.clear();
    resetExitHint();
    leaveHistoryBrowse();
    refreshDraft();
    return;
  }
  if (ctrlCExitStage === 0) {
    ctrlCExitStage = 1;
    pushLog(
      `${ansi.fg(1)}Ctrl+C${ansi.reset}：${ansi.bold}再按一次 Ctrl+C 将退出程序。${ansi.reset}`,
    );
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

/** 多终端下 Shift+Enter 不一定带 key.shift；常见为 CSI + CR/LF */
function wantsSoftNewline(key: Key): boolean {
  if (key.shift) return true;
  const s = key.sequence ?? "";
  if ((key.name === "return" || key.name === "enter") && s.startsWith("\x1b")) return true;
  return false;
}

/** 未解析成 return，但整段是「修饰键 + 换行」时避免 insertText 把 ESC 当字符写进去 */
function looksLikeModifiedEnterSequence(key: Key): boolean {
  if (key.ctrl) return false;
  const s = key.sequence ?? "";
  if (s.length < 2) return false;
  if (!s.startsWith("\x1b")) return false;
  return s.endsWith("\r") || s.endsWith("\n");
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

  if (looksLikeModifiedEnterSequence(key)) {
    editor.insertNewline();
    noteBufferMutation();
    return true;
  }

  if (key.name === "return" || key.name === "enter") {
    if (wantsSoftNewline(key)) {
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
  process.stdout.write(ansi.showCursor + ansi.reset + "\n");
}

function main(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("请在真实终端里运行：pnpm start\n");
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.on("SIGINT", () => {});

  pushLog(
    `${ansi.dim}──${ansi.reset} ${ansi.bold}对话式 TTY${ansi.reset} ${ansi.dim}Enter 发送 · Shift+Enter 换行 · help · 首行↑/末行↓ 历史 · Ctrl+C 清空草稿；空时再按退出${ansi.reset}`,
  );
  pushLog(
    `${ansi.fg(3)}就绪。${ansi.reset} 输入 ${ansi.bold}help${ansi.reset} 查看命令。（不抢备用屏、不清整屏）`,
  );

  process.stdin.on("keypress", (str, key) => {
    if (!key) return;
    handleKey(str, key);
    refreshDraft();
  });

  process.stdout.on("resize", () => refreshDraft());
}

main();
