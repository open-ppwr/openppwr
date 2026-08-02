// SPDX-License-Identifier: Apache-2.0
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSecurityHeaders, WEB_CSP } from '@openppwr/security';
import { canonicalHostRedirect, injectRuntimeConfig, isApiOnlyPath, legacyRedirect, marketingRedirect, parseHostMap, requestHostname, resolveSurface, runtimeConfig } from './src/surfaces.mjs';

const host=process.env.OPENPPWR_WEB_HOST||'0.0.0.0';
const port=Number(process.env.OPENPPWR_WEB_PORT||8080);
const root=resolve(process.env.OPENPPWR_WEB_ROOT||fileURLToPath(new URL('./dist/client',import.meta.url)));
const apiOrigin=new URL(process.env.OPENPPWR_API_ORIGIN||'http://api:3000');
const mimeTypes={'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.map':'application/json; charset=utf-8','.svg':'image/svg+xml',
  // Sample downloads. Without these the generated CSV and notice files are served as
  // application/octet-stream, which works but misdescribes them.
  '.csv':'text/csv; charset=utf-8','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
// `web` is the sole edge-facing hop (loopback-bound; reached only via the operator's
// reverse proxy/tunnel, or directly if none is configured). It is therefore the one
// place trusted to decide the client IP. Client-supplied forwarding headers are always
// stripped below; CF-Connecting-IP is trusted only when the operator explicitly
// confirms every request truly arrives via their Cloudflare Tunnel/Access deployment.
const trustCloudflare=String(process.env.OPENPPWR_TRUST_CF_CONNECTING_IP||'').toLowerCase()==='true';
// Off by default: an unconfirmed proxy chain must not let a client choose its own surface via a header
// it controls. Cloudflare Tunnel does not need this — it sets Host directly per hostname.
const trustForwardedHost=String(process.env.OPENPPWR_TRUST_X_FORWARDED_HOST||'').toLowerCase()==='true';
const forwardedHeaderNames=['x-forwarded-for','x-real-ip','cf-connecting-ip','forwarded'];

// The scheme the browser actually used, which this tier used to discard and replace with a guess.
//
// It fabricated `x-forwarded-proto: https` when the Cloudflare flag was set and `http` otherwise, so every
// deployment that terminates TLS at its own reverse proxy — which is every real self-hosted deployment —
// told the API `http` while the browser's `Origin` said `https`. The API's same-origin check compares the
// scheme (deliberately, and correctly), so it concluded that a deployment's own front end was a foreign
// origin and answered `403 origin_not_allowed` to every request carrying an `Origin` header. That is every
// POST and every fetch from the workbench.
//
// It went unnoticed because the API's built-in allowlist happens to name the project's own hostnames, so
// the reference deployment never reached the same-origin branch at all. Any operator on their own domain
// did, on their first sign-in.
//
// Read from the incoming request rather than guessed. This tier binds loopback by default
// (`OPENPPWR_BIND_ADDRESS`), so the only party that can set this header is the operator's own proxy or
// tunnel — the same party whose `Host` this tier already forwards verbatim, and the same trust basis that
// makes it the edge hop at all. An internet client cannot reach it to set anything. Where no proxy set it,
// the connection's own scheme is used, which for a direct-to-container deployment is the truth.
//
// The API's scheme comparison is left exactly as strict as it was: this fixes what the API is *told*, and
// weakens nothing about what it does with it.
function forwardedProto(request){
  const declared=request.headers['x-forwarded-proto'];
  const first=(Array.isArray(declared)?declared[0]:declared||'').split(',')[0].trim().toLowerCase();
  if(first==='https'||first==='http')return first;
  if(trustCloudflare)return 'https';
  return request.socket.encrypted?'https':'http';
}
const webSecurityHeaders=buildSecurityHeaders({csp:WEB_CSP,cacheControl:null});
// Opt-in host routing. Unset means one host serves everything, which is the ordinary self-hosted
// shape and must keep working unchanged.
const hostMap=parseHostMap(process.env.OPENPPWR_HOST_MAP);

function clientIp(request){
  if(trustCloudflare){
    const cf=request.headers['cf-connecting-ip'];
    if(cf)return Array.isArray(cf)?cf[0]:cf;
  }
  return request.socket.remoteAddress||'unknown';
}

// Cache policy, decided by whether the filename identifies its own content.
//
// The owner reported still seeing an old version after a deployment. The deployed image was in fact
// old, but a caching policy that lets an HTML shell go stale would produce exactly the same symptom
// and would be far harder to diagnose, so the two must not be confusable.
//
// The HTML shell always revalidates: it names the hashed assets, so a stale shell pins a whole stale
// application. Hashed assets are immutable, because a change to their content changes their name —
// re-requesting them is pure waste. Anything else gets a short lifetime, since its name says nothing
// about its content.
function cachePolicy(file){
  if(file.endsWith('index.html'))return 'no-cache, must-revalidate';
  if(/[.-][A-Za-z0-9_-]{8,}\.(?:js|css|map)$/u.test(file))return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function withSecurityHeaders(headers){
  return {...headers,...webSecurityHeaders};
}

// The document shell, with the resolved surface stated in it.
//
// One shell per surface, built once and held. The file is small and the transformation is pure, so
// re-reading and re-injecting it on every request would buy nothing. Keyed by surface because that is
// the only thing that varies: two hosts sharing a surface share a shell.
const shellCache=new Map();
async function surfaceShell(surface){
  const cached=shellCache.get(surface);
  if(cached)return cached;
  const html=await readFile(resolve(root,'index.html'),'utf8');
  const shell=Buffer.from(injectRuntimeConfig(html,runtimeConfig(hostMap,surface)),'utf8');
  shellCache.set(surface,shell);
  return shell;
}

function proxy(request,response){
  const headers=Object.fromEntries(Object.entries(request.headers).filter(([name])=>!hopHeaders.has(name.toLowerCase())&&!forwardedHeaderNames.includes(name.toLowerCase())));
  const originalHost=request.headers.host;
  headers.host=apiOrigin.host;
  headers['x-forwarded-for']=clientIp(request);
  headers['x-forwarded-proto']=forwardedProto(request);
  // Preserves the host the browser actually addressed, so the API can recognise its own
  // same-origin traffic on a self-hosted domain the CORS allowlist cannot know in advance.
  if(originalHost)headers['x-forwarded-host']=originalHost;
  const upstream=http.request({protocol:apiOrigin.protocol,hostname:apiOrigin.hostname,port:apiOrigin.port,path:request.url,method:request.method,headers},(result)=>{
    const passthrough=Object.fromEntries(Object.entries(result.headers).filter(([name])=>!hopHeaders.has(name.toLowerCase())));
    response.writeHead(result.statusCode||502,withSecurityHeaders(passthrough));
    result.pipe(response);
  });
  upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502,withSecurityHeaders({'content-type':'application/json'}));response.end('{"error":{"code":"UPSTREAM_UNAVAILABLE"}}');});
  request.pipe(upstream);
}

async function serve(request,response){
  const url=new URL(request.url,'http://openppwr.local');
  const hostname=requestHostname(request,{trustForwardedHost});
  const surface=resolveSurface(hostMap,hostname);
  // Liveness answers before host routing. The container's own health check addresses the service by
  // its loopback address, which is deliberately not in the host map, so refusing it would mark a
  // perfectly healthy deployment as unhealthy the moment an operator declared their hostnames.
  // It reports the surface when the host is recognised and "unknown" when it is not, which is
  // itself useful: a probe reaching the wrong name shows up here.
  if(url.pathname==='/health'){response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify({status:'ok',component:'web',surface:surface||'unknown'}));return;}
  // A `www` alias of a declared host is a spelling of that host, not an unknown name, so it is sent to the
  // canonical one with its path intact instead of being refused.
  //
  // Document requests only. The API has its own host and its own origin allowlist, and an alias must not
  // become a second API origin; and a `301` is an instruction to repeat the request, which is safe to give
  // only for a method that may be repeated. Everything else falls through to the refusal below.
  if(surface===null&&['GET','HEAD'].includes(request.method)&&!url.pathname.startsWith('/v1/')){
    const canonicalHost=canonicalHostRedirect(hostMap,hostname);
    // The path is attacker-supplied, and it is being pasted after an authority. Leading slashes are
    // stripped so that whatever it contains, the location has exactly one authority and it is the
    // canonical host — `https://host//elsewhere.example/x` is a location a lenient client could read as
    // pointing somewhere else entirely.
    // The query is dropped, as it is for every other redirect here: nothing on these paths needs one, and
    // a value that ended up in a URL must not cross a host boundary.
    if(canonicalHost){response.writeHead(301,withSecurityHeaders({location:`https://${canonicalHost}/${url.pathname.replace(/^\/+/u,'')}`,'cache-control':'no-store'}));response.end();return;}
  }
  // A host the operator never declared is a misconfiguration or a probe. Serving it the marketing
  // site would make every unmapped name an accidental mirror of the product.
  if(surface===null){
    response.writeHead(404,withSecurityHeaders({'content-type':'application/json'}));
    response.end('{"error":{"code":"UNKNOWN_HOST"}}');
    return;
  }
  // The API's liveness and readiness are proxied, and were not.
  //
  // Only `/v1/` paths reached the proxy, so `/health/live` and `/health/ready` fell through to static
  // file serving and answered 404 on every deployment -- while the release and upgrade notes tell an
  // operator to point a load balancer at exactly those paths. Found on a live multi-host deployment, by
  // a verification script, not by any test: the container healthcheck asks the API container directly
  // and never crosses this tier, so the only probe that worked was the one nobody had to be told about.
  //
  // Proxied on every surface rather than routed by hostname, because a load balancer or an orchestrator
  // sends whatever Host header it was configured with -- frequently a bare IP address -- and a readiness
  // check that depends on getting the hostname right fails closed exactly when it matters. Neither body
  // discloses anything: liveness is a constant, and readiness is a boolean plus the name of the
  // subsystem that is not ready.
  //
  // `/health` is deliberately not here. It is answered above by this tier about itself, and a probe
  // asking the web server whether the web server is alive should not start depending on the API.
  if(url.pathname==='/health/live'||url.pathname==='/health/ready'){proxy(request,response);return;}
  if(url.pathname.startsWith('/v1/')){
    // The API is reachable through its own host, and through the application and demonstration hosts
    // because their pages call it same-origin. It is not reachable through the documentation, status
    // or community surfaces, which have no reason to hold a credential.
    //
    // `/v1/version` is the exception, on every surface. It is unauthenticated build metadata, and the
    // status page exists precisely to report it — refusing it there would mean the status surface
    // could not state which build is running, which is its entire purpose.
    if(hostMap&&url.pathname!=='/v1/version'&&!['api','app','demo','marketing'].includes(surface)){
      response.writeHead(404,withSecurityHeaders({'content-type':'application/json'}));
      response.end('{"error":{"code":"RESOURCE_NOT_FOUND"}}');
      return;
    }
    proxy(request,response);
    return;
  }
  // Everything below serves HTML or assets, which the API host must not do.
  if(surface==='api'&&!isApiOnlyPath(url.pathname)){
    response.writeHead(404,withSecurityHeaders({'content-type':'application/json'}));
    response.end('{"error":{"code":"RESOURCE_NOT_FOUND"}}');
    return;
  }
  if(surface==='marketing'||surface==='all'){
    // Query strings are dropped rather than forwarded. Nothing on these paths needs one, and a
    // credential or session identifier accidentally present in a URL must not cross a host boundary.
    const target=marketingRedirect(hostMap,url.pathname)||legacyRedirect(hostMap,url.pathname);
    if(target){response.writeHead(301,withSecurityHeaders({location:target,'cache-control':'no-store'}));response.end();return;}
  }
  if(!['GET','HEAD'].includes(request.method)){response.writeHead(405,withSecurityHeaders({'allow':'GET, HEAD'}));response.end();return;}
  let relative;
  try{relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');}catch{response.writeHead(400,withSecurityHeaders({}));response.end();return;}
  let file=resolve(root,relative||'index.html');
  if(file!==root&&!file.startsWith(`${root}${sep}`)){response.writeHead(404,withSecurityHeaders({}));response.end();return;}
  try{if(!(await stat(file)).isFile())throw new Error('not-file');}catch{file=resolve(root,'index.html');}
  // The document shell carries the resolved surface, so it is generated rather than streamed. Every
  // other file is served untouched.
  if(file===resolve(root,'index.html')){
    const shell=await surfaceShell(surface);
    response.writeHead(200,withSecurityHeaders({'content-type':mimeTypes['.html'],'content-length':shell.length,'cache-control':cachePolicy(file)}));
    response.end(request.method==='HEAD'?undefined:shell);
    return;
  }
  const info=await stat(file);
  response.writeHead(200,withSecurityHeaders({'content-type':mimeTypes[extname(file)]||'application/octet-stream','content-length':info.size,'cache-control':cachePolicy(file)}));
  if(request.method==='HEAD')response.end();else createReadStream(file).pipe(response);
}

const server=http.createServer((request,response)=>serve(request,response).catch(()=>{if(!response.headersSent)response.writeHead(500);response.end();}));
server.listen(port,host,()=>console.log(`OpenPPWR web listening on ${host}:${port}`));
function shutdown(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10_000).unref();}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
