// The Files view's code editor (public/files.js fxEdit): CodeMirror 6, bundled by bin/editor/build.sh into
// public/vendor/cm/ (editor.js plus one lazily loaded chunk per language). Colours come from files.css through
// classHighlighter's tok-* classes, so light and dark mode follow the app's own CSS variables.
//   createEditor({parent, doc, name, wrap, onChange, onSave}) → Promise<{view, text(), dirty(), markSaved(), setWrap(on),
//     focus(), gotoLine(n), destroy()}>
//   name picks the language by extension (or basename: Dockerfile, Makefile, .env…); unknown names edit as plain text.
//   onChange(dirty) runs when the dirty state flips; onSave() on ⌘S / Ctrl+S.
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars,
  rectangularSelection, crosshairCursor, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, StreamLanguage, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search, gotoLine } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { classHighlighter } from '@lezer/highlight';

const legacy = (load, key) => async () => StreamLanguage.define((await load())[key]);
const LANGS = {
  js: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  ts: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  md: async () => (await import('@codemirror/lang-markdown')).markdown(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  py: async () => (await import('@codemirror/lang-python')).python(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  rs: async () => (await import('@codemirror/lang-rust')).rust(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  sh: legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell'),
  toml: legacy(() => import('@codemirror/legacy-modes/mode/toml'), 'toml'),
  ini: legacy(() => import('@codemirror/legacy-modes/mode/properties'), 'properties'),
  docker: legacy(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile'),
  rb: legacy(() => import('@codemirror/legacy-modes/mode/ruby'), 'ruby'),
  swift: legacy(() => import('@codemirror/legacy-modes/mode/swift'), 'swift'),
  nginx: legacy(() => import('@codemirror/legacy-modes/mode/nginx'), 'nginx'),
  make: legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell'),
};
const EXT = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', json: 'json', jsonc: 'json', webmanifest: 'json',
  md: 'md', markdown: 'md', mdx: 'md', html: 'html', htm: 'html', vue: 'vue', svelte: 'html', css: 'css', scss: 'css', less: 'css',
  py: 'py', pyw: 'py', yml: 'yaml', yaml: 'yaml', sql: 'sql', xml: 'xml', svg: 'xml', plist: 'xml', rs: 'rs', go: 'go', java: 'java', kt: 'java',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', php: 'php', sh: 'sh', bash: 'sh', zsh: 'sh', toml: 'toml', ini: 'ini', cfg: 'ini',
  conf: 'ini', properties: 'ini', env: 'ini', rb: 'rb', swift: 'swift', caddyfile: 'nginx' };
export function langOf(name) {
  const base = String(name || '').toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'docker';
  if (base === 'makefile') return 'make';
  if (base === 'caddyfile') return 'nginx';
  if (/^\.env(\..*)?$/.test(base) || base === '.npmrc' || base === '.editorconfig' || base === '.gitconfig') return 'ini';
  if (/^\.(bash|zsh)rc$|^\.profile$/.test(base)) return 'sh';
  const m = /\.([^.]+)$/.exec(base);
  return (m && EXT[m[1]]) || null;
}

// The indent the file already uses: tabs, or the most common step between indented lines (2 or 4 spaces).
function guessIndent(doc) {
  let tabs = 0, two = 0, four = 0, prev = 0;
  for (const line of doc.split('\n', 2000)) {
    if (!line.trim()) continue;
    if (line[0] === '\t') { tabs++; continue; }
    const n = line.length - line.trimStart().length, d = Math.abs(n - prev);
    if (d === 2) two++; else if (d === 4) four++;
    prev = n;
  }
  return tabs > two + four ? '\t' : four > two ? '    ' : '  ';
}

export async function createEditor({ parent, doc = '', name = '', wrap = false, onChange = () => {}, onSave = () => {} }) {
  const lang = new Compartment(), wrapping = new Compartment();
  let saved = doc, wasDirty = false, gone = false;
  const unit = guessIndent(doc);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
        EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(classHighlighter), bracketMatching(),
        closeBrackets(), autocompletion({ activateOnTyping: false }), rectangularSelection(), crosshairCursor(), highlightActiveLine(),
        highlightSelectionMatches(), search({ top: true }), indentUnit.of(unit), EditorState.tabSize.of(unit === '\t' ? 4 : unit.length),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } },
          { key: 'Mod-g', run: gotoLine },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
        ]),
        lang.of([]), wrapping.of(wrap ? EditorView.lineWrapping : []),
        EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': `Edit ${name}` }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const d = u.state.doc.toString() !== saved;
          if (d !== wasDirty) { wasDirty = d; onChange(d); }
        }),
      ],
    }),
  });
  const key = langOf(name);
  if (key) LANGS[key]().then((ext) => !gone && view.dispatch({ effects: lang.reconfigure(ext) })).catch(() => {});
  return {
    view,
    text: () => view.state.doc.toString(),
    dirty: () => view.state.doc.toString() !== saved,
    markSaved(text = view.state.doc.toString()) { saved = text; const d = view.state.doc.toString() !== saved; if (d !== wasDirty) { wasDirty = d; onChange(d); } },
    setWrap: (on) => view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) }),
    focus: () => view.focus(),
    gotoLine(n) {
      const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    },
    destroy() { gone = true; view.destroy(); },
  };
}
