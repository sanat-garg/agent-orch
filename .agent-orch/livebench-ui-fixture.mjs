import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLiveBenchStore } from '../livebench.mjs';
import { previewDelegation, rankingEntries, rankCandidates, curatedCandidates } from '../delegate.mjs';
const catalog = { antigravity: ['gemini-3.8-flash-high','gemini-3.7-flash-high','gemini-3.6-flash-high','unmatched-model'].map(id => ({id,label:id})) };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-ui-'));
const store = createLiveBenchStore({ dataDir: dir, metaDir: '.agent-orch', catalog: () => catalog });
if (!await store.refresh()) throw Error(JSON.stringify(store.view()));
const real = store.view();
console.log(JSON.stringify({release:real.release,fetched_at:real.fetched_at,source_urls:real.source_urls}));
const all = catalog.antigravity.map(m => ({agent:'antigravity',model:m.id,label:m.label}));
http.createServer((req,res) => {
 const u = new URL(req.url,'http://localhost');
 if(u.pathname === '/app.css') {res.setHeader('content-type','text/css');return res.end(fs.readFileSync('public/app.css'));}
 const mode=u.searchParams.get('state')||'real', view=structuredClone(real);
 if(mode==='stale') { view.stale=true;view.data_error='LiveBench refresh failed (fixture)'; }
 if(mode==='unavailable'||mode==='loading') {view.data_status=mode;view.entries=[];view.release=null;view.fetched_at=null;}
 const current=all[mode==='unmatched'?3:0], entries=rankingEntries(view);
 const fallbacks=mode==='owner'||mode==='owner-stale'?[all[3],all[2],all[1]]:null;
 if(mode==='owner-stale') {view.stale=true;entries.length=0;}
 const args={current,entries,all,usage:()=>({status:'available'}),category:'coding',fallbacks};
 const d={...view,...previewDelegation(args)};
 const engine=fallbacks?curatedCandidates({current,entries,list:fallbacks,category:'coding'}):rankCandidates({current,entries,available:all,category:'coding'});
 if(u.pathname==='/data') {res.setHeader('content-type','application/json');return res.end(JSON.stringify({d,engine:engine.candidates.slice(0,3)}));}
 const app=fs.readFileSync('public/app.js','utf8'), html=fs.readFileSync('public/index.html','utf8');
 const start=html.indexOf('<div class="modal sheet ap-pop"');
 const markup=html.slice(start,start+html.slice(start).indexOf('</div>\n</div>')+13).replace('id="apModal" hidden','id="apModal"');
 const funcs=app.slice(app.indexOf('function renderAutoPreview()'),app.indexOf('const pickVal ='));
 const metrics=app.slice(app.indexOf('const DG_METRICS ='),app.indexOf('function openDelegate('));
 res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css">${markup}<script>
 const $=id=>document.getElementById(id),el=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';if(text)e.textContent=text;return e};
 const state={},shortLabel=a=>a,apName=r=>r.label||r.model,apStatusText=r=>r.status,modelLabel=(a,m)=>m,apKey=r=>r.agent+'/'+r.model,relTime=t=>new Date(t).toISOString();
 const AP={data:${JSON.stringify(d)},fe:{}},AP_ST={available:'Available'},AGENT_LIST=[],apSaveFallbacks=()=>{},toast=()=>{};
 ${metrics}\n${funcs}\nrenderAutoPreview();
 if(innerWidth>800){const p=document.querySelector('.modal-panel');p.style.left='420px';p.style.bottom='50px'}
 if(location.search.includes('details')){document.querySelector('details').open=true;document.querySelector('details').scrollIntoView({block:'start'});}
 </script>`);
}).listen(3998,'127.0.0.1');
