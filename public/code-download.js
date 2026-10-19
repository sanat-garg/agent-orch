// Download for Markdown code blocks in chat replies (#messages) and task output (#taskDrawer). Each `pre > code` inside a
// rendered reply (.msg.text, .dr-said, .out-text) gets a .cd-bar just before it, so the action sits outside the code text
// and outside the pre that shell click-to-copy captures. The file holds the code's exact text (textContent, whitespace
// kept) through a Blob, named snippet.<ext> from a conservative language map, .txt otherwise. Empty blocks get a disabled
// button. Streaming replaces a reply's innerHTML, which drops the old bars: one MutationObserver per container re-adds
// them for the new nodes only (no timer), and a pre that already has its bar is skipped, so there are never two.
(() => {
  const ROOTS = ['messages', 'taskDrawer'];
  const SCOPE = '.msg.text, .dr-said, .out-text';
  const EXT = {
    js: 'js', javascript: 'js', mjs: 'mjs', cjs: 'cjs', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx',
    py: 'py', python: 'py', python3: 'py', rb: 'rb', ruby: 'rb', go: 'go', golang: 'go', rs: 'rs', rust: 'rs',
    java: 'java', kt: 'kt', kotlin: 'kt', swift: 'swift', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'hpp',
    cs: 'cs', csharp: 'cs', php: 'php', lua: 'lua', r: 'r', scala: 'scala', dart: 'dart',
    sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'txt', ps1: 'ps1', powershell: 'ps1',
    html: 'html', xml: 'xml', svg: 'svg', css: 'css', scss: 'scss', less: 'less', vue: 'vue', svelte: 'svelte',
    json: 'json', jsonc: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', ini: 'ini', env: 'env', csv: 'csv',
    sql: 'sql', graphql: 'graphql', md: 'md', markdown: 'md', diff: 'diff', patch: 'diff', dockerfile: 'Dockerfile', makefile: 'mk',
    text: 'txt', txt: 'txt', plaintext: 'txt',
  };
  const langOf = (code) => (code.className.match(/\blanguage-(\S+)/)?.[1] || '').toLowerCase();
  const fileName = (lang) => {
    const ext = Object.hasOwn(EXT, lang) ? EXT[lang] : 'txt';
    return ext === 'Dockerfile' ? ext : `snippet.${ext}`;
  };
  const isEmpty = (text) => !text.trim();
  const fail = (msg) => (typeof toast === 'function' ? toast(msg, { kind: 'error' }) : console.error(msg));

  function download(pre) {
    const code = pre?.querySelector(':scope > code');
    if (!code || !pre.isConnected) return fail('Couldn’t download: this code block is no longer on the page.');
    const text = code.textContent;
    if (isEmpty(text)) return fail('Nothing to download: this code block is empty.');
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName(langOf(code));
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      fail(`Couldn’t download the code: ${e?.message || e}`);
    }
  }

  function decorate(pre) {
    const code = pre.querySelector(':scope > code');
    if (!code || !pre.parentNode || !pre.closest(SCOPE)) return;
    const prev = pre.previousElementSibling;
    if (prev?.classList.contains('cd-bar')) {
      if (prev.cdPre === pre) return;
      prev.remove(); // its pre was swapped for this one
    }
    const bar = document.createElement('div');
    bar.className = 'cd-bar';
    bar.cdPre = pre;
    const lang = langOf(code);
    if (lang) bar.append(Object.assign(document.createElement('span'), { className: 'cd-lang', textContent: lang }));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cd-btn';
    b.textContent = 'Download';
    const name = fileName(lang);
    if (isEmpty(code.textContent)) { b.disabled = true; b.title = 'This code block is empty'; } else b.title = `Download as ${name}`;
    b.setAttribute('aria-label', b.disabled ? 'Download (empty code block)' : `Download code as ${name}`);
    b.addEventListener('click', (e) => { e.stopPropagation(); download(bar.cdPre); });
    bar.append(b);
    pre.before(bar);
  }

  function scan(node) {
    if (node.nodeType !== 1 || node.classList.contains('cd-bar')) return;
    if (node.nodeName === 'PRE') decorate(node);
    else for (const pre of node.querySelectorAll('pre')) decorate(pre);
  }

  for (const id of ROOTS) {
    const root = document.getElementById(id);
    if (!root) continue;
    scan(root);
    new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) scan(n); }).observe(root, { childList: true, subtree: true });
  }
})();
