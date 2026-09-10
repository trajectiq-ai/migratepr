/** Minimal ANSI helpers — no dependency on chalk. */

const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function wrap(code: string, text: string): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const bold = (t: string): string => wrap('1', t);
export const dim = (t: string): string => wrap('2', t);
export const red = (t: string): string => wrap('31', t);
export const green = (t: string): string => wrap('32', t);
export const yellow = (t: string): string => wrap('33', t);
export const cyan = (t: string): string => wrap('36', t);
