/** 多行文本缓冲 + 光标：不依赖 readline 多行，纯内存模型 */

export type Cursor = { line: number; col: number };

function charWidth(ch: string): number {
  return /[\u0000-\u007f]/.test(ch) ? 1 : 2;
}

function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

function columnForVisualWidth(text: string, targetWidth: number): number {
  let width = 0;
  let col = 0;
  for (const ch of text) {
    const nextWidth = width + charWidth(ch);
    if (nextWidth > targetWidth) break;
    width = nextWidth;
    col += ch.length;
  }
  return col;
}

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
  preferredVisualCol: number | null;

  constructor(lines: string[], cur: Cursor) {
    this.lines = lines;
    this.cur = cur;
    this.preferredVisualCol = null;
  }

  private clearPreferredVisualCol(): void {
    this.preferredVisualCol = null;
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
    this.clearPreferredVisualCol();
  }

  insertNewline(): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    const left = row.slice(0, col);
    const right = row.slice(col);
    this.lines[line] = left;
    this.lines.splice(line + 1, 0, right);
    this.cur = { line: line + 1, col: 0 };
    this.clearPreferredVisualCol();
  }

  backspace(): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    if (col > 0) {
      this.lines[line] = row.slice(0, col - 1) + row.slice(col);
      this.cur = { line, col: col - 1 };
      this.clearPreferredVisualCol();
      return;
    }
    if (line > 0) {
      const prev = this.lines[line - 1] ?? "";
      const merged = prev + row;
      this.lines.splice(line, 1);
      this.lines[line - 1] = merged;
      this.cur = { line: line - 1, col: prev.length };
      this.clearPreferredVisualCol();
    }
  }

  deleteForward(): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    if (col < row.length) {
      this.lines[line] = row.slice(0, col) + row.slice(col + 1);
      this.clearPreferredVisualCol();
      return;
    }
    if (line < this.lines.length - 1) {
      const next = this.lines[line + 1] ?? "";
      this.lines[line] = row + next;
      this.lines.splice(line + 1, 1);
      this.clearPreferredVisualCol();
    }
  }

  moveLeft(): void {
    const { line, col } = this.cur;
    if (col > 0) {
      this.cur = { line, col: col - 1 };
      this.clearPreferredVisualCol();
      return;
    }
    if (line > 0) {
      const prevLen = (this.lines[line - 1] ?? "").length;
      this.cur = { line: line - 1, col: prevLen };
      this.clearPreferredVisualCol();
    }
  }

  moveRight(): void {
    const { line, col } = this.cur;
    const row = this.lines[line] ?? "";
    if (col < row.length) {
      this.cur = { line, col: col + 1 };
      this.clearPreferredVisualCol();
      return;
    }
    if (line < this.lines.length - 1) {
      this.cur = { line: line + 1, col: 0 };
      this.clearPreferredVisualCol();
    }
  }

  moveUp(): void {
    if (this.cur.line <= 0) return;
    const prevRow = this.lines[this.cur.line - 1] ?? "";
    const currentRow = this.lines[this.cur.line] ?? "";
    const targetVisualCol =
      this.preferredVisualCol ?? visualWidth(currentRow.slice(0, this.cur.col));
    const col = columnForVisualWidth(prevRow, targetVisualCol);
    this.cur = { line: this.cur.line - 1, col };
    this.preferredVisualCol = targetVisualCol;
  }

  moveDown(): void {
    if (this.cur.line >= this.lines.length - 1) return;
    const nextRow = this.lines[this.cur.line + 1] ?? "";
    const currentRow = this.lines[this.cur.line] ?? "";
    const targetVisualCol =
      this.preferredVisualCol ?? visualWidth(currentRow.slice(0, this.cur.col));
    const col = columnForVisualWidth(nextRow, targetVisualCol);
    this.cur = { line: this.cur.line + 1, col };
    this.preferredVisualCol = targetVisualCol;
  }

  moveLineStart(): void {
    this.cur = { line: this.cur.line, col: 0 };
    this.clearPreferredVisualCol();
  }

  moveLineEnd(): void {
    const row = this.lines[this.cur.line] ?? "";
    this.cur = { line: this.cur.line, col: row.length };
    this.clearPreferredVisualCol();
  }

  clear(): void {
    this.lines = [""];
    this.cur = { line: 0, col: 0 };
    this.clearPreferredVisualCol();
  }

  /** 整段替换（用于历史召回） */
  loadFromString(text: string): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.lines = normalized.length ? normalized.split("\n") : [""];
    const last = this.lines.length - 1;
    const lastRow = this.lines[last] ?? "";
    this.cur = { line: last, col: lastRow.length };
    this.clearPreferredVisualCol();
  }

  getText(): string {
    return this.lines.join("\n");
  }

  /** 提交后重置为单行空 */
  resetAfterSubmit(): void {
    this.clear();
  }
}
