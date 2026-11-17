/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The glob dialect GitHub Actions uses for branch and path filters:
 * `*` matches within one path segment, `**` across segments, `?` one
 * character. A leading `!` negates, and later patterns override earlier
 * ones, so `['models/**', '!models/archive/**']` reads as written.
 */

export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Does `value` pass the filter list? An empty or missing list passes everything. */
export function matchesFilters(patterns, value) {
  if (!patterns || patterns.length === 0) return true;
  let matched = false;
  for (const raw of patterns) {
    const negate = raw.startsWith('!');
    const re = globToRegExp(negate ? raw.slice(1) : raw);
    if (re.test(value)) matched = !negate;
  }
  return matched;
}
