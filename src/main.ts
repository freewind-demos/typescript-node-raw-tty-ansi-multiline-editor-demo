import * as readline from "node:readline";
import process from "node:process";
import type { Key } from "node:readline";
import * as ansi from "./ansi.js";
import { createEditor } from "./editor.js";

type Block =
  | { kind: "user"; lines: string[] }
  | { kind: "assistant"; lines: string[] }
  | { kind: "system"; lines: string[] }
  | { kind: "diff"; title: string; lines: string[] }
  | { kind: "palette"; title: string; lines: string[] }
  | { kind: "code"; title: string; lines: string[] };

type FooterModel = {
  lines: string[];
  cursorLineIndex: number;
  cursorCol: number;
};

const editor = createEditor();
const transcript: Block[] = [];
const submitHistory: string[] = [];

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let historyPos: number | null = null;
let historyDraft = "";
let ctrlCExitArmed = false;
let spinnerIndex = 0;
let spinnerTimer: NodeJS.Timeout | null = null;
let typingDots = 0;
let typingLastActivityAt = 0;
let typingTimer: NodeJS.Timeout | null = null;
let pending = false;
let pendingQueue = 0;
let prevFooterLines = 0;
let footerAnchorSaved = false;
let isShuttingDown = false;

function termW(): number {
  return Math.max(40, process.stdout.columns ?? 80);
}

function termH(): number {
  return Math.max(12, process.stdout.rows ?? 24);
}

function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[\u0000-\u007f]/.test(ch) ? 1 : 2;
  return width;
}

function fitPlain(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = /[\u0000-\u007f]/.test(ch) ? 1 : 2;
    if (used + w > maxWidth) break;
    out += ch;
    used += w;
  }
  return out;
}

function wrapPlain(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  if (!text.length) return [""];
  const out: string[] = [];
  let row = "";
  let used = 0;
  for (const ch of text) {
    const w = /[\u0000-\u007f]/.test(ch) ? 1 : 2;
    if (used + w > maxWidth) {
      out.push(row);
      row = ch;
      used = w;
      continue;
    }
    row += ch;
    used += w;
  }
  out.push(row);
  return out;
}

function paintLine(text: string, fg = "", bg = ""): string {
  const width = termW();
  const body = fitPlain(text, width);
  const pad = Math.max(0, width - visualWidth(body));
  return `${bg}${fg}${body}${" ".repeat(pad)}${ansi.reset}`;
}

function renderBubble(
  lines: string[],
  theme: { bodyBg: string; bodyFg: string },
): string[] {
  const width = termW();
  const prefix = "• ";
  const bodyWidth = Math.max(8, width - 4 - visualWidth(prefix));
  const out: string[] = [];
  for (const line of lines) {
    for (const part of wrapPlain(line, bodyWidth)) {
      out.push(paintLine(`  ${prefix}${part}`, theme.bodyFg, theme.bodyBg));
    }
  }
  return out;
}

function renderUserBox(lines: string[]): string[] {
  const width = termW();
  const innerWidth = Math.max(8, width - 6);
  const topBottom = "-".repeat(innerWidth + 2);
  const out = [`${ansi.fg256(244)}  +${topBottom}+${ansi.reset}${ansi.clearLineEnd}`];
  for (const line of lines) {
    for (const part of wrapPlain(line, innerWidth)) {
      const pad = Math.max(0, innerWidth - visualWidth(part));
      out.push(
        `${ansi.fg256(244)}  |${ansi.reset}${ansi.fg256(239)} ${part}${" ".repeat(pad)} ${ansi.reset}${ansi.fg256(244)}|${ansi.reset}${ansi.clearLineEnd}`,
      );
    }
  }
  out.push(`${ansi.fg256(244)}  +${topBottom}+${ansi.reset}${ansi.clearLineEnd}`);
  return out;
}

function renderSystem(lines: string[]): string[] {
  return lines.map((line) => paintLine(`  ${line}`, ansi.fg256(245)));
}

function renderPalette(title: string, lines: string[]): string[] {
  return [paintLine(`  ${ansi.fg(2)}${title}${ansi.reset}`), ...lines];
}

function renderCode(title: string, lines: string[]): string[] {
  const out = [paintLine(`  ${ansi.fg(2)}${title}${ansi.reset}`)];
  for (const line of lines) out.push(paintLine(`    ${line}`, ansi.fg256(250)));
  return out;
}

function renderDiff(title: string, lines: string[]): string[] {
  const out = [paintLine(`  ${ansi.fg(2)}${title}${ansi.reset}`)];
  for (const line of lines) {
    let fg = ansi.fg256(250);
    let bg = "";
    if (line.startsWith("@@")) {
      fg = ansi.fg256(117);
    } else if (line.startsWith("+")) {
      fg = ansi.fg256(158);
    } else if (line.startsWith("-")) {
      fg = ansi.fg256(224);
    } else if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      fg = ansi.fg256(222);
    }
    out.push(paintLine(`    ${line}`, fg, bg));
  }
  return out;
}

function renderBlock(block: Block): string[] {
  if (block.kind === "user") {
    return renderUserBox(block.lines);
  }
  if (block.kind === "assistant") {
    return renderBubble(block.lines, {
      bodyBg: "",
      bodyFg: ansi.fg256(250),
    });
  }
  if (block.kind === "system") return renderSystem(block.lines);
  if (block.kind === "diff") return renderDiff(block.title, block.lines);
  if (block.kind === "palette") return renderPalette(block.title, block.lines);
  return renderCode(block.title, block.lines);
}

function trimTranscript(): void {
  const maxBlocks = Math.max(30, termH() * 3);
  if (transcript.length > maxBlocks) transcript.splice(0, transcript.length - maxBlocks);
}

function eraseFooter(): void {
  const out = process.stdout;
  if (footerAnchorSaved) out.write("\x1b[u");
  if (prevFooterLines > 0) {
    out.write(`\x1b[${prevFooterLines}A\x1b[0J`);
    prevFooterLines = 0;
  }
}

function footerStatusText(): string {
  if (pending) {
    const frame = spinnerFrames[spinnerIndex % spinnerFrames.length] ?? spinnerFrames[0]!;
    const queued = pendingQueue > 0 ? ` · 队列 ${pendingQueue}` : "";
    return `${frame} assistant thinking… 1s mock latency${queued}`;
  }
  return "Enter 发送 · Shift+Enter 换行 · ↑↓ 首尾切历史 · Ctrl+C 清空/退出";
}

function isTypingActive(): boolean {
  return editor.getText().length > 0 && Date.now() - typingLastActivityAt < 1000;
}

function typingIndicator(): string {
  const frames = ["-", "\\", "|", "/"];
  return frames[typingDots % frames.length] ?? frames[0]!;
}

function ensureTypingTimer(): void {
  if (typingTimer) return;
  typingTimer = setInterval(() => {
    if (!isTypingActive()) {
      if (typingTimer) clearInterval(typingTimer);
      typingTimer = null;
      refreshFooter();
      return;
    }
    typingDots++;
    refreshFooter();
  }, 300);
}

function markTypingActivity(): void {
  typingLastActivityAt = Date.now();
  typingDots = (typingDots + 1) % 4;
  ensureTypingTimer();
}

function stopTypingIndicator(): void {
  typingLastActivityAt = 0;
  typingDots = 0;
  if (typingTimer) clearInterval(typingTimer);
  typingTimer = null;
}

function renderFooter(): FooterModel {
  const width = termW();
  const lines: string[] = [];
  const showTyping = isTypingActive();
  const metaCount = (pending ? 1 : 0) + 1;

  if (pending) lines.push(paintLine(` ${footerStatusText()}`, ansi.fg256(230), ansi.bg256(60)));
  const typing = showTyping ? `   ${typingIndicator()}` : "";
  lines.push(
    paintLine(
      ` 行 ${editor.cur.line + 1}/${editor.lines.length} · 列 ${editor.cur.col + 1} · 历史 ${submitHistory.length}${typing}`,
      ansi.fg256(245),
    ),
  );

  const idlePrefix = ". ";
  const activePrefix = "> ";
  const contentMax = Math.max(8, width - visualWidth(activePrefix));

  for (let i = 0; i < editor.lines.length; i++) {
    const prefix = i === editor.cur.line ? activePrefix : idlePrefix;
    const text = fitPlain(editor.lines[i] ?? "", contentMax);
    lines.push(paintLine(`${prefix}${text}`, ansi.fg256(235), ansi.bg256(254)));
  }

  const activeLine = editor.lines[editor.cur.line] ?? "";
  const left = fitPlain(activeLine.slice(0, editor.cur.col), contentMax);
  const cursorCol = Math.min(width, visualWidth(activePrefix) + visualWidth(left) + 1);

  return {
    lines,
    cursorLineIndex: metaCount + editor.cur.line,
    cursorCol,
  };
}

function placeFooterCursor(model: FooterModel): void {
  const up = model.lines.length - model.cursorLineIndex;
  process.stdout.write(`\x1b[${up}A\r`);
  if (model.cursorCol > 1) process.stdout.write(`\x1b[${model.cursorCol - 1}C`);
}

function refreshFooter(): void {
  if (isShuttingDown) return;
  const out = process.stdout;
  const model = renderFooter();

  out.write(ansi.hideCursor);
  eraseFooter();
  for (const line of model.lines) out.write(line + ansi.clearLineEnd + "\n");
  prevFooterLines = model.lines.length;
  out.write("\x1b[s");
  placeFooterCursor(model);
  out.write(ansi.showCursor);
  footerAnchorSaved = true;
}

function rerenderAll(): void {
  if (isShuttingDown) return;
  const out = process.stdout;
  out.write(ansi.hideCursor + ansi.home + "\x1b[0J");
  for (const block of transcript) {
    for (const line of renderBlock(block)) out.write(line + ansi.clearLineEnd + "\n");
  }
  prevFooterLines = 0;
  footerAnchorSaved = false;
  refreshFooter();
}

function appendBlock(block: Block): void {
  const out = process.stdout;
  transcript.push(block);
  trimTranscript();
  out.write(ansi.hideCursor);
  eraseFooter();
  for (const line of renderBlock(block)) out.write(line + ansi.clearLineEnd + "\n");
  footerAnchorSaved = false;
  refreshFooter();
}

function pushSystem(...lines: string[]): void {
  appendBlock({ kind: "system", lines });
}

function pushUser(text: string): void {
  appendBlock({
    kind: "user",
    lines: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"),
  });
}

function pushAssistant(...lines: string[]): void {
  appendBlock({ kind: "assistant", lines });
}

function pushDiff(title: string, lines: string[]): void {
  appendBlock({ kind: "diff", title, lines });
}

function pushPalette(title: string, lines: string[]): void {
  appendBlock({ kind: "palette", title, lines });
}

function pushCode(title: string, lines: string[]): void {
  appendBlock({ kind: "code", title, lines });
}

function resetExitHint(): void {
  ctrlCExitArmed = false;
}

function leaveHistoryBrowse(): void {
  historyPos = null;
  historyDraft = "";
}

function noteBufferMutation(): void {
  resetExitHint();
  leaveHistoryBrowse();
}

function historyPrev(): void {
  if (submitHistory.length === 0) return;
  if (historyPos === null) {
    historyDraft = editor.getText();
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
    editor.loadFromString(submitHistory[historyPos] ?? "");
  } else {
    historyPos = null;
    editor.loadFromString(historyDraft);
    historyDraft = "";
  }
  resetExitHint();
}

function handleCtrlC(): void {
  if (editor.getText().length > 0) {
    editor.clear();
    stopTypingIndicator();
    leaveHistoryBrowse();
    resetExitHint();
    refreshFooter();
    return;
  }

  if (!ctrlCExitArmed) {
    ctrlCExitArmed = true;
    pushSystem("Ctrl+C 再按一次退出。当前草稿为空。");
    return;
  }

  cleanup();
  process.exit(0);
}

function startSpinner(): void {
  pending = true;
  spinnerIndex = 0;
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = setInterval(() => {
    spinnerIndex++;
    refreshFooter();
  }, 80);
}

function stopSpinner(): void {
  pending = false;
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = null;
}

function renderPaletteDemo(): void {
  const basic = Array.from({ length: 8 }, (_, i) => `${ansi.bg(i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7)}  ${ansi.reset}`).join(" ");
  const vivid = Array.from({ length: 12 }, (_, i) => `${ansi.bg256(20 + i * 12)}  ${ansi.reset}`).join(" ");
  const gradient = Array.from({ length: 24 }, (_, i) => {
    const r = Math.round((i / 23) * 255);
    const g = 120;
    const b = 255 - r;
    return `${ansi.bgTrue(r, g, b)} ${ansi.reset}`;
  }).join("");

  pushAssistant("收到 demo", "下面三行分别是 16 色、256 色、truecolor 渐变。");
  pushPalette("Palette", [basic, vivid, gradient]);
}

function renderPatchDemo(): void {
  pushAssistant(
    "收到 demo",
    "终端里最常见展示之一就是 patch。这里把文件头、hunk、增删行做分色。",
    "这个版本是单流往下长，输入区始终贴在最底下。"
  );
  pushDiff("git diff -- src/chat.ts", [
    "diff --git a/src/chat.ts b/src/chat.ts",
    "index 8d1a4f1..e3a7c42 100644",
    "--- a/src/chat.ts",
    "+++ b/src/chat.ts",
    "@@ -12,7 +12,11 @@ export function sendMessage(text: string) {",
    '-  socket.write(JSON.stringify({ text }));',
    '+  socket.write(JSON.stringify({',
    '+    text,',
    '+    sentAt: new Date().toISOString(),',
    '+  }));',
    "   pendingCount++;",
    "@@ -28,6 +32,7 @@ export function renderFooter() {",
    '+  showSpinner("assistant thinking");',
    "   showPrompt();",
    " }",
  ]);
}

function renderCodeDemo(): void {
  pushAssistant("收到 demo", "代码块也按顺序插进 transcript，不会固定在屏幕某一块。");
  pushCode("src/editor.ts", [
    "function moveUp() {",
    "  // 到顶时切历史，而不是继续卡住",
    "  if (cursor.line === 0) historyPrev();",
    "  else cursor.line--;",
    "}",
  ]);
}

function handleCommand(text: string): void {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const cmd = (s: string) => `${ansi.fg(2)}${s}${ansi.reset}`;
  const received = `${ansi.fg(6)}收到消息${ansi.reset}`;

  if (!trimmed) return;

  if (lower === "help" || lower === "?") {
    pushAssistant(
      `内置命令：${cmd("help")} ${cmd("clear")} ${cmd("demo all")} ${cmd("demo colors")} ${cmd("demo patch")} ${cmd("demo code")} ${cmd("demo status")}`
    );
    return;
  }

  if (lower === "clear") {
    transcript.length = 0;
    rerenderAll();
    pushSystem("对话区已清空。");
    return;
  }

  if (lower === "demo colors") {
    renderPaletteDemo();
    return;
  }

  if (lower === "demo patch" || lower === "demo diff") {
    renderPatchDemo();
    return;
  }

  if (lower === "demo code") {
    renderCodeDemo();
    return;
  }

  if (lower === "demo status") {
    pushAssistant("收到 demo", "发送后先出现 spinner，再补出回复。");
    return;
  }

  if (lower === "demo all") {
    pushAssistant("收到 demo", "发送后先出现 spinner，再补出回复。");
    renderPaletteDemo();
    renderPatchDemo();
    renderCodeDemo();
    return;
  }

  if (lower.includes("patch") || lower.includes("diff")) {
    pushAssistant("收到 demo");
    renderPatchDemo();
    return;
  }

  if (lower.includes("颜色") || lower.includes("color")) {
    pushAssistant("收到 demo");
    renderPaletteDemo();
    return;
  }

  pushAssistant(`${received} ${text.replaceAll("\n", " ↵ ")}`);
}

async function simulateAssistantResponse(text: string): Promise<void> {
  pendingQueue = Math.max(0, pendingQueue - 1);
  startSpinner();
  refreshFooter();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  stopSpinner();
  handleCommand(text);
  refreshFooter();
}

function enqueueResponse(text: string): void {
  pendingQueue++;
  if (pending) {
    refreshFooter();
    void waitForQueue(text);
    return;
  }
  void simulateAssistantResponse(text);
}

async function waitForQueue(text: string): Promise<void> {
  while (pending) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await simulateAssistantResponse(text);
}

function onSubmit(): void {
  const text = editor.getText();
  if (!text.trim()) {
    editor.resetAfterSubmit();
    stopTypingIndicator();
    leaveHistoryBrowse();
    refreshFooter();
    return;
  }

  submitHistory.push(text);
  editor.resetAfterSubmit();
  stopTypingIndicator();
  leaveHistoryBrowse();
  resetExitHint();
  pushUser(text);
  enqueueResponse(text);
}

function wantsSoftNewline(str: string | undefined, key: Key): boolean {
  if ((key.name === "return" || key.name === "enter") && key.shift) return true;

  if (
    str === "\n" ||
    str === "\x1b\r" ||
    str === "\x1b[13;2u" ||
    str === "\x1b[27;2;13~"
  ) {
    return true;
  }

  const s = key.sequence ?? "";
  if (
    s === "\n" ||
    s === "\x1b\r" ||
    s === "\x1b[13;2u" ||
    s === "\x1b[27;2;13~"
  ) {
    return true;
  }

  if ((key.name === "return" || key.name === "enter") && s.startsWith("\x1b")) return true;
  return false;
}

function looksLikeModifiedEnterSequence(str: string | undefined, key: Key): boolean {
  if (key.ctrl) return false;
  if (
    str === "\n" ||
    str === "\x1b\r" ||
    str === "\x1b[13;2u" ||
    str === "\x1b[27;2;13~"
  ) {
    return true;
  }
  const s = key.sequence ?? "";
  if (
    s === "\n" ||
    s === "\x1b\r" ||
    s === "\x1b[13;2u" ||
    s === "\x1b[27;2;13~"
  ) {
    return true;
  }
  if (s.length < 2 || !s.startsWith("\x1b")) return false;
  return s.endsWith("\r") || s.endsWith("\n");
}

function handleKey(str: string | undefined, key: Key): void {
  if (key.ctrl && key.name === "c") {
    handleCtrlC();
    return;
  }
  if (key.ctrl && key.name === "l") {
    rerenderAll();
    return;
  }
  if (key.name === "escape") return;

  if (key.ctrl && key.name === "a") {
    editor.moveLineStart();
    markTypingActivity();
    resetExitHint();
    return;
  }
  if (key.ctrl && key.name === "e") {
    editor.moveLineEnd();
    markTypingActivity();
    resetExitHint();
    return;
  }
  if (key.name === "home") {
    editor.moveLineStart();
    markTypingActivity();
    resetExitHint();
    return;
  }
  if (key.name === "end") {
    editor.moveLineEnd();
    markTypingActivity();
    resetExitHint();
    return;
  }

  if (looksLikeModifiedEnterSequence(str, key)) {
    editor.insertNewline();
    noteBufferMutation();
    markTypingActivity();
    return;
  }

  if (key.name === "return" || key.name === "enter") {
    if (wantsSoftNewline(str, key)) {
      editor.insertNewline();
      noteBufferMutation();
      markTypingActivity();
    } else {
      onSubmit();
    }
    return;
  }

  if (key.name === "up") {
    if (editor.cur.line > 0) editor.moveUp();
    else historyPrev();
    markTypingActivity();
    resetExitHint();
    return;
  }

  if (key.name === "down") {
    if (editor.cur.line < editor.lines.length - 1) editor.moveDown();
    else historyNext();
    markTypingActivity();
    resetExitHint();
    return;
  }

  if (key.name === "left") {
    editor.moveLeft();
    markTypingActivity();
    resetExitHint();
    return;
  }

  if (key.name === "right") {
    editor.moveRight();
    markTypingActivity();
    resetExitHint();
    return;
  }

  if (key.name === "backspace") {
    editor.backspace();
    noteBufferMutation();
    markTypingActivity();
    return;
  }

  if (key.name === "delete" || key.name === "forwarddelete") {
    editor.deleteForward();
    noteBufferMutation();
    markTypingActivity();
    return;
  }

  if (key.name === "tab") {
    editor.insertText("  ");
    noteBufferMutation();
    markTypingActivity();
    return;
  }

  const seq = key.sequence ?? "";
  if (seq && !key.ctrl && !key.meta && key.name === undefined) {
    editor.insertText(seq);
    noteBufferMutation();
    markTypingActivity();
    return;
  }

  if (str && !key.ctrl && !key.meta) {
    if (key.name && ["return", "enter", "tab"].includes(key.name)) return;
    editor.insertText(str);
    noteBufferMutation();
    markTypingActivity();
  }
}

function cleanup(): void {
  isShuttingDown = true;
  stopSpinner();
  stopTypingIndicator();
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(ansi.reset + ansi.showCursor + "\n");
}

function main(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("请在真实终端里运行：pnpm start\n");
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.on("SIGINT", () => {});

  const cmd = (s: string) => `${ansi.fg(2)}${s}${ansi.reset}`;

  pushSystem(
    "Raw TTY CLI demo ready.",
    `试试：${cmd("help")} / ${cmd("demo all")} / ${cmd("demo patch")} / ${cmd("demo colors")}`
  );

  process.stdin.on("keypress", (str, key) => {
    if (!key) return;
    handleKey(str, key);
    refreshFooter();
  });

  process.stdout.on("resize", () => rerenderAll());
}

main();
