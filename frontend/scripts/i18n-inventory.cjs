const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const found = new Set();
// Template fragments end where a substitution starts, so a trailing separator (":", "·", "،") is not part of the key.
const normalize = (text) => text.trim().replace(/\s+/g, ' ').replace(/\s*[:·،]$/, '');
const paired = new Set();
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && !['generated', 'i18n'].includes(entry.name)) scan(file);
    else if (/\.tsx?$/.test(file) && !file.endsWith('.spec.ts')) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        // Explicit pick(ar, en) calls already supply both translations. Do not
        // require a duplicate dictionary entry for a component-local message.
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'pick') {
          const [arabic, english] = node.arguments;
          if (arabic && english && ts.isStringLiteral(arabic) && ts.isStringLiteral(english) && english.text.trim()) {
            paired.add(arabic.text.trim().replace(/\s+/g, ' '));
          }
          // A template pair (`... ${x}` / `... ${x}`) supplies both languages too: every Arabic fragment of the first argument is covered.
          const isText = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n));
          if (isText(arabic) && isText(english) && (ts.isTemplateExpression(arabic) || ts.isTemplateExpression(english))) {
            (function mark(n) {
              if ((ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && /[؀-ۿ]/.test(n.text)) paired.add(normalize(n.text));
              ts.forEachChild(n, mark);
            })(arabic);
          }
        }
        // Dynamic messages: each literal fragment of a template with substitutions is inspected too.
        if ((ts.isStringLiteral(node) || ts.isJsxText(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /[\u0600-\u06ff]/.test(node.text)) {
          const value = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? normalize(node.text) : node.text.trim().replace(/\s+/g, ' ');
          if (value) found.add(value);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}
scan('src'); scan('../backend/src');
const base = { ...require('../src/i18n/base-messages.json'), ...require('../src/i18n/messages.json') };
// Reverse direction: a dictionary key with an empty English value is as untranslated as a missing key.
const empty = Object.entries(base).filter(([, english]) => typeof english !== 'string' || !english.trim()).map(([key]) => key);
const missing = [...found].filter(value => !base[value] && !paired.has(value));
process.stdout.write(JSON.stringify(missing, null, 2));
if (empty.length) process.stderr.write(`
Empty English values: ${JSON.stringify(empty)}
`);
if (process.argv.includes('--check') && (missing.length || empty.length)) process.exitCode = 1;
