/**
 * Minimal glob support for scan exclusions — no dependency.
 * Supports: `*` (within a segment), `**` (across segments, as a full segment
 * or trailing), `?`, and `{a,b}` alternation.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const prevSlash = i === 0 || pattern[i - 1] === '/';
        const afterDouble = pattern[i + 2] === '/';
        if (prevSlash && afterDouble) {
          re += '(?:[^/]+/)*';
          i += 2; // consume '**/'
        } else {
          re += '.*';
          i += 1; // consume '**'
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(',')
          .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when a posix rel path matches any compiled exclusion regex. */
export function isExcluded(relPath: string, regexes: RegExp[]): boolean {
  return regexes.some(re => re.test(relPath));
}
