// GET /js/xstate.js: the browser snippet. Customers add it to their site with their publishable key:
//
//   <script>window.xstate=window.xstate||function(){(xstate.q=xstate.q||[]).push(arguments)};xstate('init','pk_live_…')</script>
//   <script async src="https://api.xstate.com/js/xstate.js"></script>
//
//   xstate('init', key, { autocapture: false, respectDoNotTrack: false, cookie: false })   // options are optional
//   xstate('identify', userId, { email, name, plan: 'pro' }, userHash)   // userHash from your server, see collect.ts
//   xstate('identify', null, { email: 'lead@example.com' })              // a lead from a form, no hash needed
//   xstate('track', 'viewed_pricing', { plan: 'pro' })
//   xstate('page')                                                        // automatic on load and on route changes
//   xstate('reset')                                                       // on sign-out: a new anonymous visitor
//
// The visitor id and the current visit live in a first-party cookie on the site's top domain (acme.com, also read
// on www.acme.com and app.acme.com), so a visitor who goes from the marketing site to the app stays one visitor
// with one visit. The top domain is the shortest one the browser lets the page set a cookie on (browsers refuse
// public suffixes such as .com or .co.uk). They're also kept in localStorage, the fallback when cookies are blocked;
// an id found only there moves into the cookie, so visitors from before 2.1.0 keep theirs. cookie: false keeps them
// in localStorage only (per origin, as before 2.1.0). Events are batched for a moment and sent as text/plain (no CORS preflight)
// with keepalive, so they survive navigation. Events go back to wherever the script was loaded from (so a local API
// gets local events); `fallbackOrigin` is only used if the browser can't say.
//
// Collected automatically (version 2):
// - A visit (session) id, new after 30 minutes without activity or when the visitor arrives from a different
//   campaign or site. The visit's first page carries its UTM tags, ad click id and referrer.
// - Screen and window size, language and time zone, on every event.
// - On leaving a page (another route, or the tab hidden): the time spent on it and how far it was scrolled.
// - Clicks on links to other sites, as "$outbound_click" (autocapture: false turns this off).
// Nothing is sent when the browser asks not to be tracked (Global Privacy Control or Do Not Track), unless the site
// sets respectDoNotTrack: false, or when the page is driven by automation (navigator.webdriver).

export const SNIPPET_VERSION = '2.1.0'

export function snippet(fallbackOrigin: string): string {
  return `(function(w,d){
if(w.__xstate)return;w.__xstate=1;
var V=${JSON.stringify(SNIPPET_VERSION)},me=d.currentScript&&d.currentScript.src,API=(me?new URL(me).origin:${JSON.stringify(fallbackOrigin)})+'/v1/collect',
KEY=null,OFF=false,AUTO=true,CK=true,CD=null,queue=[],timer=null,last=null,pv=null,mem={},AID='xstate_aid',SID='xstate_sid',IDLE=30*60*1000,
UTM=['source','medium','campaign','term','content'],CLICK=['gclid','gbraid','wbraid','msclkid','fbclid','ttclid','li_fat_id','twclid'];
function store(k,v){var set=arguments.length>1;try{if(!set)return localStorage.getItem(k);if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){if(!set)return mem[k]||null;mem[k]=v}}
function cdomain(){if(CD!==null)return CD;CD='';try{var h=location.hostname,p=h.split('.');if(p.length<2||/^[0-9.]+$/.test(h)||h.indexOf(':')>=0)return CD;
for(var i=p.length-2;i>=0;i--){var dm=p.slice(i).join('.'),t='xstate_t='+rid('');d.cookie=t+';domain='+dm+';path=/;SameSite=Lax';
if(d.cookie.indexOf(t)>=0){d.cookie='xstate_t=;domain='+dm+';path=/;max-age=0';CD=dm;break}}}catch(e){}return CD}
function ck(k,v){try{if(arguments.length<2){var m=d.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));return m?decodeURIComponent(m[1]):null}
var dm=cdomain();d.cookie=k+'='+(v===null?'':encodeURIComponent(v))+';path=/;SameSite=Lax;max-age='+(v===null?0:31536000)+(dm?';domain='+dm:'')+(location.protocol==='https:'?';Secure':'')}catch(e){return null}}
function ls(k,v){if(arguments.length<2){var c=CK?ck(k):null;if(c)return c;var s=store(k);if(s&&CK)ck(k,s);return s}if(CK)ck(k,v);store(k,v)}
function rid(p){var a=new Uint8Array(12);(w.crypto||{}).getRandomValues?crypto.getRandomValues(a):a.forEach(function(_,i){a[i]=Math.random()*256});return p+Array.prototype.map.call(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('')}
function aid(){var v=ls(AID);if(!v){v=rid('vis_');ls(AID,v)}return v}
function host(u){try{return new URL(u).hostname.toLowerCase().replace(/^www\\./,'')}catch(e){return''}}
function same(a,b){return a===b||a.slice(-b.length-1)==='.'+b||b.slice(-a.length-1)==='.'+a}
function attribution(){var q,c={},has=false,click=null,ref=d.referrer||'',rh=host(ref),key='';
try{q=new URL(location.href).searchParams}catch(e){q=null}
if(q){UTM.forEach(function(k){var v=q.get('utm_'+k);if(v){c[k==='campaign'?'name':k]=v.slice(0,200);has=true}});
for(var i=0;i<CLICK.length;i++){var v=q.get(CLICK[i]);if(v){click={kind:CLICK[i],value:v.slice(0,500)};break}}}
if(rh&&same(rh,host(location.href)))ref='';
if(has)key='utm:'+[c.source,c.medium,c.name].join('|');else if(click)key='click:'+click.kind;else if(ref)key='ref:'+host(ref);
return{campaign:has?c:null,clickId:click,referrer:ref||null,key:key}}
function session(attr){var s=null,now=Date.now(),start;try{s=JSON.parse(ls(SID)||'null')}catch(e){}
start=!s||!s.id||now-s.t>IDLE||!!(attr&&attr.key&&attr.key!==s.k);
if(start)s={id:rid('ses_'),k:attr?attr.key:''};s.t=now;ls(SID,JSON.stringify(s));return{id:s.id,start:start}}
function context(attr){var c={library:{name:'xstate.js',version:V},screen:(w.screen?screen.width+'x'+screen.height:undefined),viewport:w.innerWidth+'x'+w.innerHeight,locale:navigator.language};
try{c.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}
var s=session(attr);c.session={id:s.id,start:s.start};
if(s.start&&attr){if(attr.campaign)c.campaign=attr.campaign;if(attr.clickId)c.clickId=attr.clickId;if(attr.referrer)c.referrer=attr.referrer}
return c}
function flush(){timer=null;if(!KEY||!queue.length)return;var events=queue.splice(0,50);
try{fetch(API,{method:'POST',keepalive:true,headers:{'Content-Type':'text/plain'},body:JSON.stringify({key:KEY,anonymousId:aid(),events:events})}).catch(function(){})}catch(e){}
if(queue.length)flush()}
function push(e,attr){if(OFF)return;e.timestamp=new Date().toISOString();e.context=context(attr);queue.push(e);if(!timer)timer=setTimeout(flush,300)}
function scrolled(){var h=d.documentElement,b=d.body,max=Math.max(h.scrollHeight,b?b.scrollHeight:0)-w.innerHeight;return max<=0?100:Math.min(100,Math.round((w.scrollY||h.scrollTop||0)/max*100))}
function leave(){if(!pv)return;if(pv.shown){pv.ms+=Date.now()-pv.shown;pv.shown=null}
if(pv.ms>=1000&&(pv.ms!==pv.sentMs||pv.scroll!==pv.sentScroll)){pv.sentMs=pv.ms;pv.sentScroll=pv.scroll;push({type:'page_leave',url:pv.url,properties:{duration_ms:pv.ms,scroll_depth:pv.scroll}})}}
function page(){var u=location.href;if(u===last)return;var first=last===null;leave();last=u;
pv={url:u,ms:0,shown:d.visibilityState==='hidden'?null:Date.now(),scroll:scrolled()};
var p={path:location.pathname,title:d.title};if(location.search)p.search=location.search;if(location.hash)p.hash=location.hash;
var attr=first?attribution():null;if(attr&&attr.referrer)p.referrer=attr.referrer;
push({type:'page',url:u,properties:p},attr)}
function outbound(ev){if(!AUTO)return;var t=ev.target,a=t&&t.closest?t.closest('a[href]'):null;if(!a||!/^https?:/i.test(a.href))return;
var h=host(a.href);if(!h||same(h,host(location.href)))return;push({type:'track',event:'$outbound_click',url:location.href,properties:{href:a.href.slice(0,500),domain:h}});flush()}
var api={
init:function(k,o){o=o||{};KEY=k;AUTO=o.autocapture!==false;CK=o.cookie!==false;
var n=navigator;if(n.webdriver||(o.respectDoNotTrack!==false&&(n.globalPrivacyControl||n.doNotTrack==='1'||w.doNotTrack==='1')))OFF=true;
page();var p=history.pushState,r=history.replaceState;history.pushState=function(){p.apply(this,arguments);setTimeout(page,0)};history.replaceState=function(){r.apply(this,arguments);setTimeout(page,0)};w.addEventListener('popstate',page);
w.addEventListener('scroll',function(){if(pv){var s=scrolled();if(s>pv.scroll)pv.scroll=s}},{passive:true});
d.addEventListener('click',outbound,true);
d.addEventListener('visibilitychange',function(){if(d.visibilityState==='hidden'){leave();flush()}else if(pv&&!pv.shown)pv.shown=Date.now()});
w.addEventListener('pagehide',function(){leave();flush()})},
identify:function(userId,traits,userHash){var e={type:'identify',url:location.href,traits:traits||{}};if(userId){e.userId=String(userId);if(userHash)e.userHash=userHash}push(e)},
track:function(name,props){push({type:'track',event:String(name),url:location.href,properties:props||{}})},
page:function(){last=null;page()},
reset:function(){leave();flush();ls(AID,null);ls(SID,null);mem={}}
};
var pending=(w.xstate&&w.xstate.q)||[];
w.xstate=function(m){var f=api[m];if(f)f.apply(null,Array.prototype.slice.call(arguments,1))};
for(var i=0;i<pending.length;i++)w.xstate.apply(null,pending[i]);
})(window,document);
`
}
