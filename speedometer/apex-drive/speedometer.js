const $=i=>document.getElementById(i);
const ld=k=>{try{return JSON.parse(localStorage.getItem(k))||{}}catch(e){return{}}};
const sv=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
const S=Object.assign({mph:false,limit:120,max:200,tw:195,ta:65,rim:15,fd:4.1,gears:'3.58,2.04,1.35,0.97,0.76',idle:800,red:6500,eco:2000,peak:5000,beep:true},ld('apex.cfg'));
let KV,DV,UL,DL;
const fresh=()=>({est:0,a:0,dem:0,fl:0,lt:0,dist:0,tt:0,tm:0,max:0,g:0,gT:0,alt:null,hd:null,acc:null,prev:null,hist:[],tz:{s:'arm',t:0,r:null},P:4,still:true,anc:null,sc:0,mc:0,rej:0,src:'–',buf:[]});
let st=fresh(),watch=null,sim=null,ac=null,lastBeep=0;
function units(){KV=S.mph?2.236936:3.6;DV=S.mph?1/1609.344:.001;UL=S.mph?'mph':'km/h';DL=S.mph?'mi':'km';
 $('bUnit').textContent=UL;buildBg();}
/* ---------- GPS pipeline ---------- */
function hav(a,b){const R=6371000,r=Math.PI/180,dl=(b.lat-a.lat)*r,dn=(b.lon-a.lon)*r,
 h=Math.sin(dl/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
/* ================= PRECISION ENGINE =================
 1 Quality gate   fixes worse than maxAcc metres are ignored
 2 Source model   chip Doppler speed is trusted; speed derived from positions is only used when the
                  movement is larger than the position error over a 5 s baseline (stops GPS drift looking like speed)
 3 Zero-velocity lock  once stopped (3 quiet fixes) speed is held at exactly 0 until real movement is confirmed
 4 Kalman filter  gain adapts to signal quality: poor signal = smoother, good signal = no lag
 5 Outlier guard  a jump over 12 m/s in one second is distrusted
 6 Distance       trapezoid integration of filtered speed, never while locked                     */
const E={maxAcc:60,stopIn:.55,goOut:1.1,q:4,jump:12};
function feed(v,acc,t,hd,alt,lat,lon){
 acc=acc||99;const dt=st.lt?t-st.lt:0;
 if(st.lt&&dt<=0)return;
 st.acc=acc;if(acc>E.maxAcc){st.rej++;return}
 const hasD=v!=null&&!isNaN(v);let m,sig,src;
 if(lat!=null)st.buf.push({lat,lon,t,acc});
 while(st.buf.length>2&&t-st.buf[0].t>5)st.buf.shift();
 if(hasD){m=Math.max(0,v);sig=Math.max(.25,acc/25);src='Doppler'}
 else if(lat!=null&&st.buf.length>1){const o=st.buf[0],d=hav(o,{lat,lon}),w=t-o.t;
  m=w>1&&d>2*Math.max(acc,o.acc)?d/w:0;sig=Math.max(1,acc*1.4/Math.max(w,1));src='derived'}
 else{m=0;sig=3;src='none'}
 if(m<E.stopIn){st.sc++;st.mc=0}else if(m>=E.goOut){st.mc++;st.sc=0}
 if(!st.still&&st.sc>=3&&st.est<2.5){st.still=true;st.anc=null}
 if(st.still&&!st.anc&&lat!=null)st.anc={lat,lon,n:1};
 else if(st.still){
  const away=st.anc&&lat!=null?hav(st.anc,{lat,lon}):0;
  const go=src==='Doppler'?((m>=3&&acc<=20)||(st.mc>=2&&away>acc)||st.mc>=4):(st.mc>=5&&away>2.5*acc);
  if(go){st.still=false;st.anc=null}}
 const p0=st.est;
 if(st.still){st.est=0;st.a=0;st.P=.04;
  if(st.anc&&lat!=null){const a=st.anc,n=Math.min(a.n+1,30);a.lat+=(lat-a.lat)/n;a.lon+=(lon-a.lon)/n;a.n=n}}
 else if(dt>0&&dt<8){
  if(Math.abs(m-st.est)>E.jump)sig*=6;
  st.P+=E.q*dt;const K=st.P/(st.P+sig*sig);st.est+=K*(m-st.est);st.P*=1-K;
  st.a+=((st.est-p0)/dt-st.a)*.45}
 else{st.est=m;st.P=sig*sig;st.a=0}
 if(dt>0&&dt<8){st.tt+=dt;if(!st.still&&st.est>1){st.dist+=.5*(st.est+p0)*dt;st.tm+=dt}}
 st.lt=t;st.fl=performance.now();st.src=src;if(lat!=null)st.pos=st.still&&st.anc?{lat:st.anc.lat,lon:st.anc.lon}:{lat,lon};
 if(hd!=null&&!isNaN(hd)&&st.est>1)st.hd=hd;if(alt!=null)st.alt=alt;
 if(!st.still&&st.mc>=2){if(st.est>st.max)st.max=st.est}
}
const GC={nf:0,nul:0,src:'–',perm:'?'};
const FILEMSG='<b>This page is open as a file.</b> Chrome often blocks GPS for files. Host it over https (or run it from localhost) and GPS will work.';
function diag(t){const d=$('diag');d.hidden=!t;d.innerHTML=t||''}
function preflight(){
 if(location.protocol==='file:'||!isSecureContext)diag(FILEMSG);
 try{navigator.permissions.query({name:'geolocation'}).then(p=>{GC.perm=p.state;if(p.state==='denied')diag('<b>Location is blocked for this page.</b> Tap the lock icon by the address, open Permissions, set Location to Allow, then reload.');p.onchange=()=>{GC.perm=p.state}})}catch(e){}
}
function onPos(p){const c=p.coords;GC.nf++;GC.src=c.speed==null?'position only (no speed)':'GPS chip';
 if(c.speed==null)GC.nul++;else GC.nul=0;
 if(c.speed!=null&&c.accuracy<=50)diag('');
 else if(GC.nul>=6&&c.accuracy>30)diag('<b>Getting a position but no speed.</b> That usually means a laptop or Wi-Fi location. Use a phone with real GPS, outdoors, with Location on high accuracy.');
 feed(c.speed,c.accuracy,p.timestamp/1000,c.heading,c.altitude,c.latitude,c.longitude)}
function onErr(e){const f=location.protocol==='file:'?FILEMSG+'<br>':'';
 setGps('r',['','Location blocked','No location signal','Waiting for GPS…'][e.code]||'GPS error');
 if(e.code===1)diag(f+'<b>Location is blocked.</b> Allow it in Chrome (lock icon by the address, Permissions, Location) and make sure Location is on in your phone settings.');
 else if(e.code===2)diag(f+'<b>No location signal.</b> Turn Location on with high accuracy, then go outdoors or next to a window.');
 else setGps('y','Waiting for GPS lock…')}
function setGps(c,t){$('gps').className='pill '+c;$('gpst').textContent=t}
function start(){
 if(!ac)try{ac=new AudioContext()}catch(e){}
 if(watch!=null){navigator.geolocation.clearWatch(watch);watch=null;$('bStart').textContent='Start';$('bStart').classList.remove('on');setGps('','GPS off');return}
 if(!navigator.geolocation){setGps('r','No geolocation in this browser');return}
 stopSim();setGps('y','Searching for GPS…');preflight();
 watch=navigator.geolocation.watchPosition(onPos,onErr,{enableHighAccuracy:true,maximumAge:0,timeout:30000});
 $('bStart').textContent='Stop';$('bStart').classList.add('on');
 try{navigator.wakeLock&&navigator.wakeLock.request('screen')}catch(e){}try{document.documentElement.requestFullscreen().then(()=>screen.orientation.lock('landscape')).catch(()=>{})}catch(e){}
}
function stopSim(){if(sim){clearInterval(sim);sim=null;$('bDemo').classList.remove('on')}}
function demo(){
 if(sim){stopSim();return}
 if(watch!=null)start();let t0=Date.now();$('bDemo').classList.add('on');setGps('g','Demo ±3 m');
 sim=setInterval(()=>{const s=(Date.now()-t0)/1000,v=Math.max(0,16+15*Math.sin(s/9-1.57)+Math.sin(s*1.7)*.6);
  feed(v+(Math.random()-.5)*.15,3,Date.now()/1000,(s*6)%360,1250+s%40);},250);
}
/* ---------- drawing ---------- */
const hue=f=>'hsl('+((165-Math.min(1,Math.max(0,(f-.5)/.55))*170+360)%360)+',80%,60%)';
function resize(){const c=$('g'),d=devicePixelRatio||1,w=c.clientWidth;c.width=c.height=Math.round(w*d);buildBg()}
let bg=null;
function buildBg(){
 const W=$('g').width;if(!W)return;bg=document.createElement('canvas');bg.width=bg.height=W;
 const x=bg.getContext('2d'),c=W/2,T=Math.PI*2,a0=.75*Math.PI,sw=1.5*Math.PI,an=f=>a0+sw*f;
 const o0=a0-.16*Math.PI,o1=a0+sw+.16*Math.PI;x.lineCap='round';
 x.strokeStyle='rgba(255,255,255,.07)';x.lineWidth=W*.022;x.beginPath();x.arc(c,c,W*.485,o0,o1);x.stroke();
 const g=x.createConicGradient(0,c,c);['#eef2f5','#6c757d','#cfd6dc','#555d65','#eef2f5'].forEach((q,i,a)=>g.addColorStop(i/(a.length-1),q));
 x.strokeStyle=g;x.lineWidth=W*.007;x.beginPath();x.arc(c,c,W*.485,o0,o1);x.stroke();
 let r=x.createRadialGradient(c,c,0,c,c,W*.45);r.addColorStop(0,'#12171e');r.addColorStop(1,'#04060a');
 x.fillStyle=r;x.beginPath();x.arc(c,c,W*.452,0,T);x.fill();x.strokeStyle='#232a32';x.lineWidth=W*.008;x.stroke();
 const s=S.max<=100?10:S.max<=240?20:40;x.textAlign='center';x.textBaseline='middle';x.font='600 '+(W*.06)+'px "Segoe UI",Arial,sans-serif';
 for(let k=0,v=0;v<=S.max+.01;k++,v=k*s/4){const a=an(v/S.max),M=k%4===0,H=k%2===0,r1=W*.43,r2=r1-W*(M?.06:H?.04:.025),red=v>S.limit;
  x.strokeStyle=red?'#ff5d6c':M?'#f2f2f2':'#8b949e';x.lineWidth=M?W*.006:W*.003;x.beginPath();x.moveTo(c+r1*Math.cos(a),c+r1*Math.sin(a));x.lineTo(c+r2*Math.cos(a),c+r2*Math.sin(a));x.stroke();
  if(M){x.fillStyle=red?'#ff5d6c':'#f2f2f2';const q=W*.335;x.fillText(Math.round(v),c+q*Math.cos(a),c+q*Math.sin(a))}}
 x.fillStyle='#8b949e';x.font=(W*.03)+'px "Segoe UI",Arial,sans-serif';x.fillText(UL.toLowerCase(),c,c-.2*W);
}
function gauge(u){
 const cv=$('g'),W=cv.width;if(!bg||bg.width!==W)buildBg();if(!bg)return;
 const x=cv.getContext('2d'),c=W/2,T=Math.PI*2,f=Math.min(1.03,u/S.max),a=.75*Math.PI+1.5*Math.PI*f,col=u/S.limit<.85?'#f4f4f4':hue(u/S.limit);
 x.clearRect(0,0,W,W);x.drawImage(bg,0,0);
 x.save();x.translate(c,c);x.rotate(a);x.strokeStyle=col;x.shadowColor=col;x.shadowBlur=W*.014;x.lineCap='round';x.lineWidth=W*.0065;x.beginPath();x.moveTo(-W*.07,0);x.lineTo(W*.405,0);x.stroke();x.restore();
 x.fillStyle='#0a0d11';x.strokeStyle='#454d57';x.lineWidth=W*.004;x.beginPath();x.arc(c,c,W*.028,0,T);x.fill();x.stroke();
 x.fillStyle='#8b949e';x.font=(W*.034)+'px "Segoe UI",Arial,sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText((st.dist*DV).toFixed(1)+' '+DL,c,c+W*.2);
}
/* ---------- render loop (60 fps, predictive, no perceptible lag) ---------- */
let last=performance.now(),disp=0;
function loop(t){const dt=Math.min(.1,(t-last)/1000);last=t;
 const raw=(t-st.fl)/1000,age=Math.min(raw,1.2),fd=raw>4?Math.max(0,1-(raw-4)/4):1,tg=st.still?0:Math.max(0,(st.est+st.a*age*.6)*fd);
 disp+=(tg-disp)*(1-Math.exp(-dt*16));if(disp<.01&&tg===0)disp=0;
 const u=disp*KV;gauge(u);
 document.documentElement.style.setProperty('--c',hue(u/S.limit));
 const over=u>S.limit;document.body.classList.toggle('over',over);
 if(over&&S.beep&&ac&&t-lastBeep>2500){lastBeep=t;try{const o=ac.createOscillator(),g=ac.createGain();o.frequency.value=880;g.gain.value=.08;o.connect(g);g.connect(ac.destination);o.start();o.stop(ac.currentTime+.18)}catch(e){}}
 requestAnimationFrame(loop)}
/* ---------- status (4 Hz) ---------- */
function panels(){
 const age=(performance.now()-st.fl)/1000;
 $('unc').textContent=!st.fl?'':st.still?'stationary · locked at 0':'± '+(Math.sqrt(st.P)*KV).toFixed(1)+' '+UL;
 if(watch!=null){if(!st.fl)setGps('y','Searching for GPS…');else if(age>5)setGps('r','Signal lost ('+Math.round(age)+' s)');
  else{const a=st.acc;setGps(a<=10?'g':a<=25?'y':'r','GPS ±'+Math.round(a)+' m'+(a<=10?' · excellent':a<=25?' · good':' · weak'))}}
}
setInterval(panels,250);
/* ---------- controls ---------- */
$('bStart').onclick=start;$('bDemo').onclick=demo;
$('bUnit').onclick=()=>{S.mph=!S.mph;const k=S.mph?.621371:1/.621371;S.limit=Math.round(S.limit*k);S.max=Math.round(S.max*k/10)*10;sv('apex.cfg',S);units();};
if(location.protocol==='file:')diag(FILEMSG);
if('serviceWorker' in navigator){
 if(location.protocol.startsWith('http'))navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).catch(()=>{});
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!window.__r){window.__r=1;location.reload()}});
}
/* the map reads the real speedometer through this (position, heading, filtered speed in m/s) */
window.Apex={get:()=>({pos:st.pos||null,v:st.still?0:st.est,hd:st.hd,still:st.still,demo:!!sim,age:(performance.now()-st.fl)/1000})};
addEventListener('resize',resize);units();resize();requestAnimationFrame(loop);
