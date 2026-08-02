// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { test } from 'node:test';

async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
async function waitFor(url){for(let attempt=0;attempt<50;attempt+=1){try{const response=await fetch(url);if(response.ok)return response;}catch{}await new Promise((resolve)=>setTimeout(resolve,50));}throw new Error(`timeout waiting for ${url}`);}

test('web runtime serves SPA and streams API through the private origin',async()=>{
  let forwardedAuthorization;
  const api=http.createServer((request,response)=>{forwardedAuthorization=request.headers.authorization;response.writeHead(200,{'content-type':'application/json'});response.end('{"proxied":true}');});
  const apiPort=await listen(api);
  const reservation=http.createServer();
  const webPort=await listen(reservation);
  await new Promise((resolve)=>reservation.close(resolve));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,OPENPPWR_WEB_HOST:'127.0.0.1',OPENPPWR_WEB_PORT:String(webPort),OPENPPWR_API_ORIGIN:`http://127.0.0.1:${apiPort}`},stdio:'ignore'});
  try{
    const health=await waitFor(`http://127.0.0.1:${webPort}/health`);
    // "all" is the single-host shape: no OPENPPWR_HOST_MAP is set here, so this server still serves
    // every surface, exactly as a self-hosted deployment on one domain does. The field exists so an
    // operator can prove which surface answered rather than inferring it from page content.
    assert.deepEqual(await health.json(),{status:'ok',component:'web',surface:'all'});
    const page=await fetch(`http://127.0.0.1:${webPort}/en/community`);
    assert.equal(page.status,200);
    assert.match(await page.text(),/<div id="root"><\/div>/);
    const proxied=await fetch(`http://127.0.0.1:${webPort}/v1/catalog/summary`,{headers:{authorization:'Bearer synthetic'}});
    assert.deepEqual(await proxied.json(),{proxied:true});
    assert.equal(forwardedAuthorization,'Bearer synthetic');
  }finally{
    child.kill('SIGTERM');
    await new Promise((resolve)=>child.once('exit',resolve));
    await new Promise((resolve)=>api.close(resolve));
  }
});

test('with a host map the runtime serves each hostname its own surface and refuses the rest',async()=>{
  const api=http.createServer((request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{"proxied":true}');});
  const apiPort=await listen(api);
  const reservation=http.createServer();
  const webPort=await listen(reservation);
  await new Promise((resolve)=>reservation.close(resolve));
  const hostMap='marketing:openppwr.eu,app:app.openppwr.eu,demo:demo.openppwr.eu,docs:docs.openppwr.eu,api:api.openppwr.eu,status:status.openppwr.eu,community:community.openppwr.eu';
  // This test's own `as()` helper simulates a different hostname per request via X-Forwarded-Host — a
  // convenience for exercising host-map routing without real DNS. Trusting that header at all is opt-in
  // and off by default, so this spawned process explicitly opts in; production does not set this.
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,OPENPPWR_WEB_HOST:'127.0.0.1',OPENPPWR_WEB_PORT:String(webPort),OPENPPWR_API_ORIGIN:`http://127.0.0.1:${apiPort}`,OPENPPWR_HOST_MAP:hostMap,OPENPPWR_TRUST_X_FORWARDED_HOST:'true'},stdio:'ignore'});
  const as=(hostname,path='/',options={})=>fetch(`http://127.0.0.1:${webPort}${path}`,{redirect:'manual',...options,headers:{'x-forwarded-host':hostname,...(options.headers||{})}});
  try{
    // The container's own probe addresses the loopback address, which is deliberately not in the
    // host map. Health must still answer, or declaring hostnames would make a healthy deployment
    // report itself unhealthy.
    const loopbackHealth=await waitFor(`http://127.0.0.1:${webPort}/health`);
    assert.deepEqual(await loopbackHealth.json(),{status:'ok',component:'web',surface:'unknown'});

    // Each declared hostname reports the surface that answered, so routing can be proven rather
    // than inferred from page content.
    for(const [hostname,surface] of [['openppwr.eu','marketing'],['app.openppwr.eu','app'],['docs.openppwr.eu','docs'],['status.openppwr.eu','status']]){
      assert.deepEqual(await (await as(hostname,'/health')).json(),{status:'ok',component:'web',surface});
    }

    // The API's liveness and readiness must reach the API from every surface, including hostnames that
    // are refused the rest of the API. A load balancer or an orchestrator sends whatever Host header it
    // was configured with -- frequently a bare IP -- and a readiness probe that depends on getting the
    // hostname right fails closed exactly when it matters.
    //
    // Asserted as "the API answered" rather than "not 404", which is what an earlier version of this test
    // checked and why it passed against the broken code: an unproxied path falls through to static
    // serving and the single-page fallback returns 200, so "not 404" was true while the probe was
    // reaching the wrong tier entirely.
    for(const hostname of ['docs.openppwr.eu','status.openppwr.eu','community.openppwr.eu','openppwr.eu']){
      for(const path of ['/health/live','/health/ready']){
        const probe=await as(hostname,path);
        assert.deepEqual(await probe.json(),{proxied:true},`${path} on ${hostname} must reach the API, not the static tier`);
      }
    }

    // A hostname the operator never declared is refused. Serving it the marketing site would make
    // every unmapped name an accidental mirror of the product.
    const unknown=await as('openppwr.eu.attacker.example','/en/pricing');
    assert.equal(unknown.status,404);
    assert.equal((await unknown.json()).error.code,'UNKNOWN_HOST');

    // The API hostname serves the API and nothing else.
    assert.equal((await as('api.openppwr.eu','/en/pricing')).status,404);
    assert.equal((await as('api.openppwr.eu','/')).status,404);
    assert.deepEqual(await (await as('api.openppwr.eu','/v1/catalog/summary')).json(),{proxied:true});

    // Documentation, status and community never hold a credential, so they cannot reach the API.
    for(const hostname of ['docs.openppwr.eu','status.openppwr.eu','community.openppwr.eu']){
      const denied=await as(hostname,'/v1/catalog/summary');
      assert.equal(denied.status,404,`${hostname} must not proxy to the API`);
    }
    // The application and demonstration surfaces must keep working, because their pages call the
    // API same-origin.
    for(const hostname of ['app.openppwr.eu','demo.openppwr.eu']){
      assert.deepEqual(await (await as(hostname,'/v1/catalog/summary')).json(),{proxied:true},`${hostname} must proxy to the API`);
    }

    // Cross-host redirects, and no loop back to the issuing host. The `/app` segment survives the
    // jump: dropping it landed the user on `/{locale}`, which rendered the marketing homepage.
    const redirected=await as('openppwr.eu','/pl/app');
    assert.equal(redirected.status,301);
    assert.equal(redirected.headers.get('location'),'https://app.openppwr.eu/pl/app');
    assert.equal((await as('openppwr.eu','/de/docs')).headers.get('location'),'https://docs.openppwr.eu/de');

    // Unlocalized legacy paths resolve to one canonical location instead of serving a second
    // indexable copy of the same page.
    const legacy=await as('openppwr.eu','/product');
    assert.equal(legacy.status,301);
    assert.equal(legacy.headers.get('location'),'/en/product');
    assert.equal((await as('openppwr.eu','/docs')).headers.get('location'),'https://docs.openppwr.eu/en');

    // The defect this whole change exists to close: six hostnames served one byte-identical document,
    // so the browser had nothing to distinguish them by and rendered the marketing homepage on all of
    // them. Each surface must now receive its own shell.
    const shells=new Map();
    for(const hostname of ['openppwr.eu','app.openppwr.eu','demo.openppwr.eu','docs.openppwr.eu','status.openppwr.eu','community.openppwr.eu']){
      const document=await (await as(hostname,'/pl')).text();
      const surface=/name="openppwr-runtime" content="([^"]*)"/u.exec(document)?.[1];
      assert.ok(surface,`${hostname} served a document with no surface declaration`);
      shells.set(hostname,document);
    }
    assert.equal(new Set([...shells.values()]).size,shells.size,'the surfaces are serving identical documents again');
    assert.match(shells.get('demo.openppwr.eu'),/&quot;surface&quot;:&quot;demo&quot;/u);
    assert.match(shells.get('docs.openppwr.eu'),/&quot;surface&quot;:&quot;docs&quot;/u);

    // A query string is dropped rather than forwarded across a host boundary: a credential that
    // ended up in a URL must not travel with the redirect.
    const withQuery=await as('openppwr.eu','/en/demo?token=should-not-travel');
    assert.equal(withQuery.headers.get('location'),'https://demo.openppwr.eu/en');

    // The Community product page stays on the marketing host.
    const product=await as('openppwr.eu','/pl/community');
    assert.equal(product.status,200);

    // `www` is a spelling of the apex, not a name nobody declared. It carries its path to the canonical
    // host rather than receiving the refusal above, and it is never served content of its own: a second
    // hostname answering `200` would put every page at two indexable URLs.
    const www=await as('www.openppwr.eu','/pl/pricing');
    assert.equal(www.status,301);
    assert.equal(www.headers.get('location'),'https://openppwr.eu/pl/pricing');
    assert.equal((await as('www.openppwr.eu','/')).headers.get('location'),'https://openppwr.eu/');
    // The query does not cross the boundary.
    assert.equal((await as('www.openppwr.eu','/en?token=should-not-travel')).headers.get('location'),'https://openppwr.eu/en');
    // The requested path is pasted after an authority, so no path may produce a location that points at a
    // different one — the property is asserted on the parsed location, not on the string.
    for(const path of ['//elsewhere.example/x','/%2f%2felsewhere.example','/en/../../elsewhere.example']){
      const location=(await as('www.openppwr.eu',path)).headers.get('location');
      assert.ok(location&&new URL(location).host==='openppwr.eu',`${path} produced ${location}`);
    }
    // The alias is not a second API origin, and a request that must not be silently repeated is refused
    // rather than redirected.
    assert.equal((await as('www.openppwr.eu','/v1/catalog/summary')).status,404);
    assert.equal((await as('www.openppwr.eu','/en/pricing',{method:'POST'})).status,404);
  }finally{
    child.kill('SIGTERM');
    await new Promise((resolve)=>child.once('exit',resolve));
    await new Promise((resolve)=>api.close(resolve));
  }
});
