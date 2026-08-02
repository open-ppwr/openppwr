import { resolve } from 'node:path';
import express from 'express';
import { appliedMigrationLevel, createPool } from '@openppwr/database';
import { assertStrongSecrets, buildInfo } from '@openppwr/security';
import { createApp, demoProfileFinding, forbiddenPrivilegedVariables, migrationLevelFinding } from './app.mjs';

const databaseUrl=process.env.OPENPPWR_DATABASE_URL;
if(!databaseUrl)throw new Error('OPENPPWR_DATABASE_URL is required.');
if(!process.env.OPENPPWR_BOOTSTRAP_TOKEN)throw new Error('OPENPPWR_BOOTSTRAP_TOKEN is required.');
// Present is not the same as set. `openppwr.env.example` ships REPLACE_WITH_… placeholders and Compose
// checks only that a variable is non-empty, so a file copied unchanged starts a deployment whose bootstrap
// token is a string published in this repository. Refused here rather than documented, because the
// documentation already said to change it.
assertStrongSecrets({ OPENPPWR_BOOTSTRAP_TOKEN: process.env.OPENPPWR_BOOTSTRAP_TOKEN });
const port=Number(process.env.OPENPPWR_PORT||3000);
const host=process.env.OPENPPWR_HOST||'0.0.0.0';
const pool=createPool(databaseUrl);
// Session issuance and the demonstration reset run on database roles the request pool cannot assume
// (migration 014). Each needs its own URL because each is a distinct database credential; reusing
// OPENPPWR_DATABASE_URL would restore the exact standing grant the separation removes.
//
// Both are optional and both fail closed: without OPENPPWR_AUTH_DATABASE_URL there is no password sign-in,
// and without OPENPPWR_MAINTENANCE_DATABASE_URL there is no reset. A deployment that holds real data wants
// neither, so absent is the right default rather than an error.
const authPool=process.env.OPENPPWR_AUTH_DATABASE_URL?createPool(process.env.OPENPPWR_AUTH_DATABASE_URL):null;
const maintenancePool=process.env.OPENPPWR_MAINTENANCE_DATABASE_URL?createPool(process.env.OPENPPWR_MAINTENANCE_DATABASE_URL):null;
// Credential rotation (migration 035), and the one privileged credential a deployment holding real data may
// load. `openppwr_rotation` holds EXECUTE on the rotation function and nothing else — no session issuance, no
// password verifier, no table grant — and that EXECUTE is not authority by itself: the function resolves the
// acting identity from the credential presented on the request, so a process holding this connection and no
// valid credential can rotate nothing. Before it existed, rotation ran on the authentication credential and
// therefore did not exist at all in production: the route below answered 404 on every deployment that held
// real data, which is the posture the recovery story was written for.
//
// Optional, and fail-closed like the other two: without it there is no rotation route rather than a
// rotation route on a wider credential.
const rotationPool=process.env.OPENPPWR_ROTATION_DATABASE_URL?createPool(process.env.OPENPPWR_ROTATION_DATABASE_URL):null;

// A URL is a claim about which principal a pool connects as; `current_user` is the fact. A deployment that
// points every variable at the same credential would satisfy every grant assertion in the schema while
// having no separation at all, and nothing else in the system would notice.
//
// Checked at startup and fatal, because the failure it prevents is silent: the reset would work, sign-in
// would work, and the boundary would be gone.
async function assertConnectedPrincipal(candidate,expected,variable){
  if(!candidate)return;
  const client=await candidate.connect();
  try{
    const [identity]=(await client.query(
      `SELECT current_user AS role,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`)).rows;
    if(identity.role!==expected)throw new Error(`${variable} connects as ${identity.role}, not ${expected}; the privilege separation is not in effect.`);
    if(identity.superuser)throw new Error(`${variable} connects as a superuser, which bypasses every boundary in the schema.`);
    if(identity.bypassrls)throw new Error(`${variable} connects as a role that bypasses row-level security.`);
  }finally{client.release();}
}

// A deployment that is not running the demonstration has no use for the sign-in or reset credential, and
// loading them anyway puts those capabilities inside the long-running request process for no benefit. The
// grants stay separated in PostgreSQL while the separation collapses in the one process an attacker reaches
// first.
//
// Refused rather than ignored: silently declining to use a credential still leaves it in the environment,
// in the process, and in anything that reads either. The rule, and why rotation is not on the list, is in
// `forbiddenPrivilegedVariables`.
const forbidden=forbiddenPrivilegedVariables(process.env);
if(forbidden.length){
  throw new Error(`${forbidden.join(' and ')} must not be set when demonstration sign-in is disabled. These credentials exist only for the demonstration profile; a deployment holding real data must not load them.`);
}

// The same rule read in the other direction: demonstration sign-in declared on, with nothing able to perform
// it. Checked here, beside its mirror, rather than left to the first person who tries to sign in and is told
// only that the resource does not exist. See `demoProfileFinding` for why this direction is fatal.
const demoFinding=demoProfileFinding(process.env);
if(demoFinding?.fatal)throw new Error(demoFinding.message);

await assertConnectedPrincipal(pool,'openppwr_app','OPENPPWR_DATABASE_URL');
await assertConnectedPrincipal(authPool,'openppwr_auth','OPENPPWR_AUTH_DATABASE_URL');
await assertConnectedPrincipal(maintenancePool,'openppwr_maintenance','OPENPPWR_MAINTENANCE_DATABASE_URL');
// The same check, and it is the reason the variable can be permitted in production at all: a URL is a claim
// about which principal a pool connects as, and `current_user` is the fact. Pointing this variable at
// `openppwr_auth` would be a production deployment loading the session-issuing credential under a name the
// startup refusal does not cover, and it fails here.
await assertConnectedPrincipal(rotationPool,'openppwr_rotation','OPENPPWR_ROTATION_DATABASE_URL');

// What this build was compiled expecting, against what the database actually carries. Until now the first
// number was reported to the world and the second was never read, so a deployment could state a schema
// version it did not have and nothing anywhere would notice.
//
// Stated on every start, agreement or not, so the ordinary log records the pair rather than only the
// exception. `migrationLevelFinding` decides what a disagreement means and which direction is fatal; the
// reasoning is there rather than here.
const declaredMigrationLevel=buildInfo().migrationLevel;
// Not caught. A database this process cannot read at startup is not a deployment that should begin serving
// on the assumption that it will work later — `assertConnectedPrincipal` above has already established that
// the connection is usable, so a failure here is the schema, not the network.
const observedMigrationLevel=await appliedMigrationLevel(pool);
console.log(`OpenPPWR migration level declared=${declaredMigrationLevel} applied=${observedMigrationLevel||'none'}`);
const migrationFinding=migrationLevelFinding(declaredMigrationLevel,observedMigrationLevel);
if(migrationFinding?.fatal)throw new Error(migrationFinding.message);
if(migrationFinding)console.warn(migrationFinding.message);

const app=createApp({pool,authPool,maintenancePool,rotationPool});
if(process.env.OPENPPWR_SERVE_WEB!=='false'){
  const webRoot=resolve(process.env.OPENPPWR_WEB_ROOT||'apps/web/dist/client');
  app.use(express.static(webRoot,{index:false,maxAge:'1h'}));
  app.get('*',(_request,response)=>response.sendFile(resolve(webRoot,'index.html')));
}
const server=app.listen(port,host,()=>console.log(`OpenPPWR listening on ${host}:${port}`));
async function shutdown(signal){console.log(`OpenPPWR received ${signal}`);server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
