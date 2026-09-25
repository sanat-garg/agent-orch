import http from 'node:http';
import fs from 'node:fs';
const root=process.cwd();
http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname.startsWith('/public/')) {res.setHeader('Content-Type',u.pathname.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(root+u.pathname));return;}
 const app=fs.readFileSync('public/app.js','utf8'), html=fs.readFileSync('public/index.html','utf8');
 const functions=app.slice(app.indexOf('function renderAutoPreview()'),app.indexOf('// Searchable "add fallback"'));
 const metrics=app.slice(app.indexOf('const DG_METRICS ='),app.indexOf('function openDelegate('));
 const row=(label,status='available')=>({agent:label.startsWith('Gemini')?'antigravity':'codex',model:label,label,status,score:50,metrics:{coding_index:50,intelligence_index:60,agentic_index:null,benchmarks:{}},reason:'coding: 50 vs starting model 50 (100%); Coding Index 50'});
 let d={start:row('GPT-5.5'),candidates:[row('Gemini 3.1 Pro'),row('GPT-6 Sol Experimental Extended Context Model With A Very Long Name'),row('UnavailableModelWithAnExtremelyLongUnbrokenIdentifierForWidthTesting','limited')],fallbacks:null,source:'artificialanalysis',category:'coding',data_status:'ready',attribution:{url:'https://artificialanalysis.ai/',text:'Artificial Analysis'}};
 if(u.searchParams.get('state')==='unconfigured'||u.searchParams.get('state')==='error'||u.searchParams.get('state')==='loading'){d.data_status=u.searchParams.get('state');d.start.metrics=null;d.start.score=null;d.candidates=[];}
 if(u.searchParams.get('state')==='request')d=null;
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/app.css">${html.slice(html.indexOf('<div class="modal sheet ap-pop"'),html.indexOf('<div class="modal sheet ap-pop"')+html.slice(html.indexOf('<div class="modal sheet ap-pop"')).indexOf('</div>\n</div>')+13).replace('id="apModal" hidden','id="apModal"')}<script>
 const $=id=>document.getElementById(id),el=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';if(text)e.textContent=text;return e};
 const state={},shortLabel=a=>a,apName=r=>r.label,apStatusText=r=>r.status,AP={data:${JSON.stringify(d)},error:'Could not load fallback data.'};
 function closeAutoPreview(){$('apModal').hidden=true} function openConnections(){window.action='connections'} function loadAutoPreview(){window.action='retry'}
 ${metrics}\n${functions}\nrenderAutoPreview();document.querySelector('[data-close].icon-btn').onclick=closeAutoPreview;
 if(innerWidth>800){const p=document.querySelector('.modal-panel');p.style.left='420px';p.style.bottom='50px'}
 if(location.search.includes('details')){document.querySelector('details').open=true;document.querySelector('details').scrollIntoView({block:'start'});}
 </script>`);
}).listen(3998,'127.0.0.1');
