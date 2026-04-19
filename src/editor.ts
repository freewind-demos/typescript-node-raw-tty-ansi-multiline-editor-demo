/** 多行文本缓冲 + 光标：不依赖 readline 多行，纯内存模型 */

export type Cursor = { line: number; col: number };

export function createEditor(initial = ""): MultilineEditor {
  const lines = initial.length ? initial.split("\n") : [""];
  return new MultilineEditor(lines, {
    line: lines.length - 1,
    col: lines[lines.length - 1]!.length,
  });
}

export class MultilineEditor {
  lines: string[];
  cur: Cursor;

  constructor(lines: string[], cur: Cursor) {
    this.lines = lines;
    this.cur = cur;
  }

  /** 粘贴或普通输入：可含换行 */
  insertText(raw: string): void {
    if (!raw) return;
    const parts = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] ?? "";
      if (i > 0) this.insertNewline();
      for (const ch of p) this.insertChar(ch);
    }
  }

  insertChar(ch: string): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    this.lines[line] = row.slice(0, col) + ch + row.slice(col);
    this.cur = { line, col: col + 1 };
  }

  insertNewline(): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    const left = row.slice(0, col);
    const right = row.slice(col);
    this.lines[line] = left;
    this.lines.splice(line + 1, 0, right);
    this.cur = { line: line + 1, col: 0 };
  }

  backspace(): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    if (col > 0) {
      this.lines[line] = row.slice(0, col - 1) + row.slice(col);
      this.cur = { line, col: col - 1 };
      return;
    }
    if (line > 0) {
      const prev = this.lines[line - 1] ?? "";
      const merged = prev + row;
      this.lines.splice(line, 1);
      this.lines[line - 1] = merged;
      this.cur = { line: line - 1, col: prev.length };
    }
  }

  deleteForward(): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    if (col < row.length) {
      this.lines[line] = row.slice(0, col) + row.slice(col + 1);
      return;
    }
    if (line < this.lines.length - 1) {
      const next = this.lines[line + 1] ?? "";
      this.lines[line] = row + next;
      this.lines.splice(line + 1, 1);
    }
  }

  moveLeft(): void {
    const { line, col } = this.cur;
    if (col > 0) {
      this.cur = { line, col: col - 1 };
      return;
    }
    if (line > 0) {
      const prevLen = (this.lines[line - 1] ?? "").length;
      this.cur = { line: line - 1, col: prevLen };
    }
  }

  moveRight(): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    if (col < row.length) {
      this.cur = { line, col: col + 1 };
      return;
    }
    if (line < this.lines.length - 1) {
      this.cur = { line: line + 1, col: 0 };
    }
  }

  moveUp(): void {
    if (this.cur.line <= 0) return;
    const prevRow = this.lines[this.cur.line - 1] ?? "";
    const col = Math.min(this.cur.col, prevRow.length);
    this.cur = { line: this.cur.line - 1, col };
  }

  moveDown(): void {
    if (this.cur.line >= this.lines.length - 1) return;
    const nextRow = this.lines[this.cur.line + 1] ?? "";
    const col = Math.min(this.cur.col, nextRow.length);
    this.cur = { line: this.cur.line + 1, col };
  }

  moveLineStart(): void {
    this.cur = { line: this.cur.line, col: 0 };
  }

  moveLineEnd(): void {
    const row = this.lines[this.cur.line] ?? "";
    this.cur = { line: this.cur.line, col: row.length };
  }

  clear(): void {
    this.lines = [""];
    this.cur = { line: 0, col: 0 };
  }

  getText(): string {
    return this.lines.join("\n");
  }

  /** 提交后重置为单行空 */
  resetAfterSubmit(): void {
    this.clear();
  }
}
