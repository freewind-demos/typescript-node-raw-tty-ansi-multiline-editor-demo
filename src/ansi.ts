/** 最小 ANSI / ECMA-48 片段：原理演示用，无外部着色库 */

export const reset = "\x1b[0m";
export const bold = "\x1b[1m";
export const dim = "\x1b[2m";
export const italic = "\x1b[3m";
export const underline = "\x1b[4m";
export const inverse = "\x1b[7m";
export const strikethrough = "\x1b[9m";

export const fg = (n: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7) => `\x1b[${30 + n}m`;
export const bg = (n: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7) => `\x1b[${40 + n}m`;

export const fg256 = (n: number) => `\x1b[38;5;${n}m`;
export const bg256 = (n: number) => `\x1b[48;5;${n}m`;

export const fgTrue = (r: number, g: number, b: number) =>
  `\x1b[38;2;${r};${g};${b}m`;
export const bgTrue = (r: number, g: number, b: number) =>
  `\x1b[48;2;${r};${g};${b}m`;

export const clearScreen = "\x1b[2J";
export const home = "\x1b[H";
export const hideCursor = "\x1b[?25l";
export const showCursor = "\x1b[?25h";
export const altScreenOn = "\x1b[?1049h";
export const altScreenOff = "\x1b[?1049l";

export const moveTo = (row: number, col: number) => `\x1b[${row};${col}H`;
export const clearLineEnd = "\x1b[K";

/** 输入区浅色底（256 色 252 ≈ 灰白） */
export const inputZoneBg = bg256(252);
export const inputZoneFg = fg256(235);
