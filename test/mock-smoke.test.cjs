/* Offline smoke test; does not use a real Torn API key. */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const script = fs.readFileSync(require('node:path').resolve(__dirname,'../attack-intelligence.user.js'),'utf8').replace('###PDA-APIKEY###','FAKEKEYFORTESTS1');
const now = Math.floor(Date.now()/1000);
const attacks = [
{id:1001,started:now-430,ended:now-400,result:'Mugged',attacker:{id:111,name:'Repeat'}},
{id:1002,started:now-330,ended:now-300,result:'Hospitalized',attacker:{id:111,name:'Repeat'}},
{id:1003,started:now-230,ended:now-200,result:'Mugged',attacker:null}
];
const logs = [
{id:'a',timestamp:now-398,details:{id:8156},data:{money:5000}},
{id:'b',timestamp:now-198,details:{id:8156},data:{money:2000}}
];
const requests=[]; const store=new Map();
class Node {
  constructor() {this.id='';this.innerHTML='';this.textContent='';this.hidden=false;this.disabled=false;this.dataset={};this.firstChild=null;this.cache=new Map();this.classList={toggle(){},add(){},remove(){}};}
  querySelector(s){if(!this.cache.has(s))this.cache.set(s,new Node());return this.cache.get(s);}
  querySelectorAll(s){if(s==='[data-group]')return ['day','week','month'].map(group=>{const b=new Node();b.dataset.group=group;return b;});return [];}
  insertBefore(el){this.inserted=el;} appendChild(el){this.appended=el;}
  addEventListener(){}
}
const host=new Node(),win={};win.self=win.top=win;
const document={body:new Node(),head:new Node(),querySelector:()=>host,getElementById:()=>null,createElement:()=>new Node(),addEventListener(){}};
vm.runInNewContext(script,{
 window:win,document,location:{pathname:'/hospitalview.php'},console,
 Date,Math,JSON,Object,String,Array,Number,Map,Set,URL,Promise,
 PDA_storage:{get:async (key,def)=>store.has(key)?store.get(key):def,set:async (key,value)=>store.set(key,value)},
 PDA_httpGet:async(url,headers)=>{
  assert(!url.includes('FAKEKEYFORTESTS1'));assert.equal(headers.Authorization,'ApiKey FAKEKEYFORTESTS1');
  const path=new URL(url).pathname;requests.push(path);
  const data=path.endsWith('/attacks')?{attacks}:path.endsWith('/log')?{log:logs}:path.endsWith('/basic')?{profile:{status:{description:'In Torn City'}}}:{travel:{destination:'Torn City'}};
  return {status:200,responseText:JSON.stringify(data)};
 }
},{filename:'attack-intelligence.user.js'});
setTimeout(()=>{
 try {
 const root=host.inserted;
 assert.equal(root?.id,'tai-root');
 assert(requests.includes('/v2/user/attacks'));
 assert(requests.includes('/v2/user/log'));
 assert(root.querySelector('#tai-kpis').innerHTML.includes('$7,000'));
 assert(root.querySelector('#tai-repeaters').innerHTML.includes('profiles.php?XID=111'));
 assert.equal(Object.keys(store.get('tai-db-v1').attacks).length,3);
 console.log('PASS: Hospital dashboard, attacks, logs, blacklist link, storage');
 }catch(e){console.error(e);process.exitCode=1;}
},100);
