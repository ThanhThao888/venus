const {chromium,devices}=require('playwright');
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
const ME='aaaaaaaa-0000-4000-8000-000000000001',B='bbbbbbbb-0000-4000-8000-000000000002',C='cccccccc-0000-4000-8000-000000000003';
(async()=>{
const br=await chromium.launch();
for(const [name,ctxOpts] of [['desktop',{viewport:{width:1100,height:800},deviceScaleFactor:1}],['mobile',{...devices['iPhone 13']}]]){
  const ctx=await br.newContext(ctxOpts), pg=await ctx.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
  await pg.goto('file://'+__dirname+'/account-devices.html');
  const open=async()=>{await pg.evaluate(()=>{window.__log=[];window.__so=[];window.__mode={};window.__meId=null;window.__init()});await pg.evaluate(()=>window.VenusAccount.open());await pg.waitForSelector('.vpis-acc-dev');await pg.waitForTimeout(200)};
  const rows=()=>pg.$$eval('.vpis-acc-dev',r=>r.map(x=>({t:x.innerText.replace(/\n/g,' | '),btn:(x.querySelector('button')||{}).innerText||null,dis:x.querySelector('button')?x.querySelector('button').disabled:null})));
  const btnFor=(i)=>pg.locator('.vpis-acc-dev').nth(i).locator('button');
  const msg=()=>pg.$eval('.vpis-acc-msg',m=>m.hidden?'':m.textContent);
  await open();
  let r=await rows();
  ok(r.length===3,name+': 3 rows'); ok(r[0].btn===null&&/This device/.test(r[0].t),name+': current device has badge, no button');
  ok(r[1].btn==='Remove'&&r[2].btn==='Remove',name+': other devices have Remove');
  // two-step
  await btnFor(1).click(); r=await rows(); ok(r[1].btn==='Confirm?'&&r[2].btn==='Remove',name+': first tap -> Confirm?');
  ok((await pg.evaluate(()=>window.__log.length))===0,name+': first tap sends nothing');
  await pg.waitForTimeout(4300); r=await rows(); ok(r[1].btn==='Remove',name+': Confirm? reverts after 4s');
  // arm another switches
  await btnFor(1).click(); await btnFor(2).click(); r=await rows(); ok(r[1].btn==='Remove'&&r[2].btn==='Confirm?',name+': arming another disarms the first');
  // double click second tap
  await btnFor(2).click(); await pg.waitForTimeout(60); r=await rows();
  ok(r[2].btn==='Removing…'&&r[1].dis&&r[2].dis,name+': busy: label + all Remove buttons disabled');
  await btnFor(2).click({force:true,timeout:500}).catch(()=>{});
  await pg.waitForTimeout(700); r=await rows();
  const log=await pg.evaluate(()=>window.__log);
  ok(log.length===1&&log[0].f.device_id===C&&log[0].f.user_id==='u1',name+': exactly one delete by (user_id, device_id)');
  ok(r.length===2&&!r.some(x=>/Windows/.test(x.t)),name+': row disappears without reload'); ok(/Device removed/.test(await msg()),name+': success message');
  // error cases
  const cases=[['42501',{err:'42501',status:403},/004_user_devices_delete/],['net',{net:true},/Can't connect/],['jwt',{err:'PGRST301',status:401},/session expired/],['500',{err:'XX000',status:500},/Couldn't remove.*XX000/],['zero',{zero:true},/already gone/]];
  for(const [n,mode,re] of cases){
    await open(); await pg.evaluate(m=>{window.__mode=m},mode);
    await btnFor(1).click(); await btnFor(1).click(); await pg.waitForTimeout(700);
    const m=await msg(); r=await rows();
    ok(re.test(m),name+': error '+n+' -> "'+m.slice(0,60)+'"');
    if(n!=='zero') ok(r.some(x=>/iPhone/.test(x.t))&&r.find(x=>/iPhone/.test(x.t)).btn==='Remove',name+': '+n+': UI not stuck, row kept, button back');
    else ok(!r.some(x=>/iPhone/.test(x.t)),name+': zero rows: list refreshed');
    await pg.evaluate(()=>window.VenusAccount.close());
  }
  // no session
  await open(); await pg.evaluate(()=>{window.__mode={noSession:true}}); await btnFor(1).click(); await btnFor(1).click(); await pg.waitForTimeout(400);
  ok(/session expired/.test(await msg())&&(await pg.evaluate(()=>window.__log.length))===0,name+': no session -> message, nothing sent'); await pg.evaluate(()=>window.VenusAccount.close());
  // offline
  await open(); await ctx.setOffline(true); await btnFor(1).click(); await btnFor(1).click(); await pg.waitForTimeout(300);
  ok(/offline/i.test(await msg())&&(await pg.evaluate(()=>window.__log.length))===0,name+': offline -> message, nothing sent'); await ctx.setOffline(false); await pg.evaluate(()=>window.VenusAccount.close());
  { const p2=await ctx.newPage(); await p2.addInitScript(()=>{Object.defineProperty(window,'VenusMemory',{configurable:true,get(){return{getDeviceId:()=>Promise.reject(new Error('x'))}}})});
    await p2.goto('file://'+__dirname+'/account-devices.html'); await p2.evaluate(()=>window.VenusAccount.open()); await p2.waitForSelector('.vpis-acc-dev'); await p2.waitForTimeout(300);
    const rr=await p2.$$eval('.vpis-acc-dev',r=>r.map(x=>!!x.querySelector('button'))); ok(rr.length===3&&rr.every(x=>!x),name+': own id unknown -> no Remove buttons anywhere'); await p2.close(); }
  await pg.evaluate(()=>{window.VenusMemory.getDeviceId=()=>Promise.resolve('aaaaaaaa-0000-4000-8000-000000000001')});
  await open(); await btnFor(1).click(); await pg.evaluate(B=>{window.VenusMemory.getDeviceId=()=>Promise.resolve(B)},B);   // simulate stale UI: this device is actually B
  await btnFor(1).click(); await pg.waitForTimeout(300);
  ok(/can't be removed/.test(await msg())&&(await pg.evaluate(()=>window.__log.length))===0,name+': click-time guard blocks removing own id');
  // ── Sign out other devices (F15) ──
  { const so=()=>pg.locator('.vpis-acc-so button'); const soLog=()=>pg.evaluate(()=>window.__so);
    await open();
    ok((await so().innerText())==='Sign out other devices',name+': sign-out-others button present');
    await so().click(); ok((await so().innerText())==='Confirm?'&&(await soLog()).length===0,name+': first tap -> Confirm?, nothing sent');
    await pg.waitForTimeout(4300); ok((await so().innerText())==='Sign out other devices',name+': Confirm? reverts after 4s');
    await so().click(); await so().click(); await pg.waitForTimeout(60);
    ok((await so().innerText())==='Signing out…'&&(await so().isDisabled()),name+': busy label + disabled');
    r=await rows(); ok(r.filter(x=>x.btn==='Remove').every(x=>x.dis),name+': Remove buttons locked while signing out others');
    await pg.waitForTimeout(700);
    const sl=await soLog(); ok(sl.length===1&&sl[0]&&sl[0].scope==='others',name+": exactly one signOut({scope:'others'}) call");
    ok(/Other devices were signed out/.test(await msg()),name+': success message');
    r=await rows(); ok(r.length===3&&!(await pg.evaluate(()=>window.__log.length)),name+': list and rows untouched, no delete sent');
    ok((await so().innerText())==='Sign out other devices'&&!(await so().isDisabled()),name+': button back to normal');
    ok(await pg.$('.vpis-acc-who')!==null,name+': this device still signed in');
    for(const [n,mode,re] of [['net',{soNet:true},/Can't connect/],['401',{soErr:'bad_jwt',soStatus:401},/session expired/],['500',{soErr:'unexpected_failure',soStatus:500},/Couldn't sign out.*unexpected_failure/]]){
      await open(); await pg.evaluate(m=>{window.__mode=m},mode); await so().click(); await so().click(); await pg.waitForTimeout(700);
      ok(re.test(await msg()),name+': so error '+n+' -> "'+(await msg()).slice(0,50)+'"');
      ok(!(await so().isDisabled())&&(await so().innerText())==='Sign out other devices',name+': so '+n+': UI not stuck'); await pg.evaluate(()=>window.VenusAccount.close());
    }
    await open(); await pg.evaluate(()=>{window.__mode={noSession:true}}); await so().click(); await so().click(); await pg.waitForTimeout(400);
    ok(/session expired/.test(await msg())&&(await soLog()).length===0,name+': so no session -> message, nothing sent'); await pg.evaluate(()=>window.VenusAccount.close());
    await open(); await ctx.setOffline(true); await so().click(); await so().click(); await pg.waitForTimeout(300);
    ok(/offline/i.test(await msg())&&(await soLog()).length===0,name+': so offline -> message, nothing sent'); await ctx.setOffline(false); await pg.evaluate(()=>window.VenusAccount.close());
    await open(); ok(!(await pg.$eval('.vpis-acc-body',b=>b.scrollWidth>b.clientWidth+1)),name+': so no horizontal overflow');
    console.log(name,'so button height',await so().evaluate(b=>Math.round(b.getBoundingClientRect().height)));
  }
  // layout: no horizontal overflow
  const ov=await pg.$eval('.vpis-acc-body',b=>b.scrollWidth>b.clientWidth+1); ok(!ov,name+': no horizontal overflow');
  const bh=await pg.$$eval('.vpis-acc-dev button',b=>b.map(x=>Math.round(x.getBoundingClientRect().height))); console.log(name,'button heights',bh);
  ok(errs.length===0,name+': no page errors '+errs.join(';'));
  await ctx.close();
}
await br.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
