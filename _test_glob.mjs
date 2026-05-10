const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(content) {
  const match = content.match(FM_RE);
  if (!match) return {meta: {}, body: content};
  const meta = {};
  const lines = (match[1] ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx > 0 && !line.match(/^\s+-/)) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) {
        meta[key] = val;
      }
    }
  }
  return {meta, body: match[2] ?? ''};
}

function globToRegex(glob) {
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { regex += '(?:.*/)?'; i += 3; }
        else { regex += '.*'; i += 2; }
      } else { regex += '[^/]*'; i++; }
    } else if (c === '?') { regex += '[^/]'; i++; }
    else if ('.+^${}()|[]\\'.includes(c)) { regex += '\\' + c; i++; }
    else { regex += c; i++; }
  }
  return new RegExp('^' + regex + '$', 'i');
}

function getGlobRegex(glob) {
  const effective = glob.includes('/') ? glob : '**/' + glob;
  return globToRegex(effective);
}

// Test frontmatter parsing
const testCases = [
  ['bare glob',         '---\nname: watch-md\nglob: *.md\nenabled: true\n---\nDo something'],
  ['quoted glob',       '---\nname: watch-md\nglob: "*.md"\nenabled: true\n---\nDo something'],
  ['single-quoted',     "---\nname: watch-md\nglob: '*.md'\nenabled: true\n---\nDo something"],
  ['no body',           '---\nname: watch-md\nglob: *.md\n---'],
  ['Windows CRLF',      '---\r\nname: watch-md\r\nglob: *.md\r\nenabled: true\r\n---\r\nDo something'],
  ['extra spaces',      '---\nname: watch-md\nglob:   *.md   \nenabled: true\n---\nDo something'],
  ['no frontmatter',    'glob: *.md\nDo something'],
  ['folder glob',       '---\nname: watch-md\nglob: folder/*.md\n---\nDo something'],
  ['enabled missing',   '---\nname: watch-md\nglob: *.md\n---\nDo something'],
  ['enabled false',     '---\nname: watch-md\nglob: *.md\nenabled: false\n---\nDo something'],
];

console.log('=== Frontmatter Parsing ===\n');
for (const [label, content] of testCases) {
  const fmMatch = content.match(FM_RE);
  if (!fmMatch) {
    console.log(`${label}: FM_RE NO MATCH => trigger would be SKIPPED`);
    continue;
  }
  const rawFm = fmMatch[1] ?? '';
  const {meta} = parseFrontmatter(`---\n${rawFm}\n---\n`);
  const glob = (typeof meta['glob'] === 'string' && meta['glob']) || undefined;
  const enabled = String(meta['enabled']).toLowerCase() !== 'false';
  console.log(`${label}: glob=${JSON.stringify(glob)} enabled=${enabled}`);
}

// Test glob regex matching
console.log('\n=== Glob Regex Matching ===\n');
const glob = '*.md';
const re = getGlobRegex(glob);
console.log(`Glob "${glob}" => regex: ${re}\n`);

const paths = [
  'daily.md', 'notes/daily.md', 'a/b/c.md', 'file.txt',
  'README.md', 'sidekick/triggers/test.trigger.md',
];
for (const p of paths) {
  console.log(`  ${p} => ${re.test(p)}`);
}

// Test with CRLF in rawFm (Windows line endings)
console.log('\n=== CRLF re-wrap edge case ===\n');
const crlfContent = '---\r\nname: watch-md\r\nglob: *.md\r\nenabled: true\r\n---\r\nDo something';
const crlfMatch = crlfContent.match(FM_RE);
if (crlfMatch) {
  const rawFm = crlfMatch[1];
  // Re-wrap uses \n, but rawFm might still have \r
  const rewrapped = `---\n${rawFm}\n---\n`;
  const {meta} = parseFrontmatter(rewrapped);
  const glob = (typeof meta['glob'] === 'string' && meta['glob']) || undefined;
  console.log(`CRLF rawFm lines:`, JSON.stringify(rawFm.split('\n')));
  console.log(`CRLF glob extracted: ${JSON.stringify(glob)}`);
  if (glob) {
    const re = getGlobRegex(glob);
    console.log(`CRLF glob regex: ${re}`);
    console.log(`CRLF test "notes/daily.md": ${re.test('notes/daily.md')}`);
  }
}
