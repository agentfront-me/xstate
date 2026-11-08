// GET /js/xstate.js: the browser snippet. Customers add it to their site with their publishable key:
//
//   <script>window.xstate=window.xstate||function(){(xstate.q=xstate.q||[]).push(arguments)};xstate('init','pk_live_…')</script>
//   <script async src="https://api.xstate.com/js/xstate.js"></script>
//
//   xstate('identify', userId, { email, name, plan: 'pro' }, userHash)   // userHash from your server, see collect.ts
//   xstate('identify', null, { email: 'lead@example.com' })              // a lead from a form, no hash needed
//   xstate('track', 'viewed_pricing', { plan: 'pro' })
//   xstate('page')                                                        // automatic on load and on route changes
//   xstate('reset')                                                       // on sign-out: a new anonymous visitor
//
// The visitor id lives in localStorage. Events are batched for a moment and sent as text/plain (no CORS preflight)
// with keepalive, so they survive navigation. Events go back to wherever the script was loaded from (so a local API
// gets local events); `fallbackOrigin` is only used if the browser can't say.

export function snippet(fallbackOrigin: string): string {
  return `(function(w,d){
if(w.__xstate)return;w.__xstate=1;
var me=d.currentScript&&d.currentScript.src,API=(me?new URL(me).origin:${JSON.stringify(fallbackOrigin)})+'/v1/collect',KEY=null,queue=[],timer=null,last=null,AID='xstate_aid';
function rid(){var a=new Uint8Array(12);(w.crypto||{}).getRandomValues?crypto.getRandomValues(a):a.forEach(function(_,i){a[i]=Math.random()*256});return'vis_'+Array.prototype.map.call(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('')}
function aid(){try{var v=localStorage.getItem(AID);if(!v){v=rid();localStorage.setItem(AID,v)}return v}catch(e){return w.__xstate_aid||(w.__xstate_aid=rid())}}
function flush(){timer=null;if(!KEY||!queue.length)return;var events=queue.splice(0,50);
try{fetch(API,{method:'POST',keepalive:true,headers:{'Content-Type':'text/plain'},body:JSON.stringify({key:KEY,anonymousId:aid(),events:events})}).catch(function(){})}catch(e){}
if(queue.length)flush()}
function push(e){e.timestamp=new Date().toISOString();queue.push(e);if(!timer)timer=setTimeout(flush,300)}
function page(){var u=location.href;if(u===last)return;last=u;push({type:'page',url:u,properties:{title:d.title,referrer:d.referrer||undefined}})}
var api={
init:function(k){KEY=k;page();var p=history.pushState,r=history.replaceState;history.pushState=function(){p.apply(this,arguments);setTimeout(page,0)};history.replaceState=function(){r.apply(this,arguments);setTimeout(page,0)};w.addEventListener('popstate',page);d.addEventListener('visibilitychange',function(){if(d.visibilityState==='hidden')flush()})},
identify:function(userId,traits,userHash){var e={type:'identify',url:location.href,traits:traits||{}};if(userId){e.userId=String(userId);if(userHash)e.userHash=userHash}push(e)},
track:function(name,props){push({type:'track',event:String(name),url:location.href,properties:props||{}})},
page:function(){last=null;page()},
reset:function(){flush();try{localStorage.removeItem(AID)}catch(e){}w.__xstate_aid=null}
};
var pending=(w.xstate&&w.xstate.q)||[];
w.xstate=function(m){var f=api[m];if(f)f.apply(null,Array.prototype.slice.call(arguments,1))};
for(var i=0;i<pending.length;i++)w.xstate.apply(null,pending[i]);
})(window,document);
`
}
