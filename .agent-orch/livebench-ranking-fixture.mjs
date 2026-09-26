import http from 'node:http';
import fs from 'node:fs';
const row = (model, score) => ({ agent: 'codex', model, label: model, status: 'available', score,
 metrics: { categories: { Coding: score, 'Agentic Coding': 62, Mathematics: 74, 'Data Analysis': 65, Reasoning: 72, Language: 80, IF: 77 }, global_average: 70, coding_index: score }, reason: 'LiveBench 2026-06-25 coding: comparable score' });
http.createServer((req,res) => {
 if (req.url === '/app.css') { res.setHeader('content-type','text/css'); return res.end(fs.readFileSync('public/app.css')); }
 const app = fs.readFileSync('public/app.js','utf8');
 const funcs = app.slice(app.indexOf('function renderAutoPreview()'), app.indexOf('const pickVal ='));
 const metrics = app.slice(app.indexOf('const DG_METRICS ='), app.indexOf('function openDelegate('));
 const d = { category:'coding', source:'livebench', release:'2026-06-25', data_status:'ready', start:row('Starting model',60), candidates:[row('Fallback model',59)], fallbacks:null, attribution:{ text:'Benchmark scores by LiveBench',url:'https://livebench.ai' } };
 res.setHeader('content-type','text/html'); res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div class="modal sheet"><div class="modal-panel"><h2 id="apTitle"></h2><p id="apSub"></p><div id="apBody"></div></div></div><script>
 const $=id=>document.getElementById(id),el=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';if(text)e.textContent=text;return e};
 const state={},shortLabel=a=>a,apName=r=>r.label,apStatusText=r=>r.status,modelLabel=(a,m)=>m,apKey=r=>r.agent+'/'+r.model;
 const AP={data:${JSON.stringify(d)},fe:{}},AP_ST={},AGENT_LIST=[],apSaveFallbacks=()=>{},toast=()=>{};
 ${metrics}\n${funcs}\nrenderAutoPreview();document.querySelector('details').open=true;
 </script>`);
}).listen(3998,'127.0.0.1');
