// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate, migrationConnectTimeoutMs } from './migrate.mjs';

const { Client }=pg;

// The runtime principals, and what each one is for. Migration 014 creates them NOLOGIN and without a
// password, because a migration must not invent a credential it would then have to store; this is where
// they become usable.
//
// `openppwr_app` serves requests. `openppwr_auth` verifies a credential and issues a session.
// `openppwr_maintenance` resets a demonstration deployment. `openppwr_rotation` replaces one identity's
// bearer credential and does nothing else (migration 035).
//
// Auth and maintenance are optional. A deployment holding real data wants neither password sign-in nor a
// reset, and absent means the capability does not exist rather than that it is available with a default.
//
// Rotation is optional for a different reason. It is the one privileged credential a production deployment
// may hold, because EXECUTE on the rotation function is not authority by itself — the function resolves the
// actor from the credential presented, so the connection alone rotates nothing. A deployment that sets no
// password here has no supported way to replace a leaked bearer token, which is a decision an operator may
// take; it must not be one they take by accident, so absence retires the role rather than leaving it
// dormant.
const PRINCIPALS=Object.freeze([
  {role:'openppwr_app',variable:'OPENPPWR_RUNTIME_DATABASE_PASSWORD',required:true},
  {role:'openppwr_auth',variable:'OPENPPWR_AUTH_DATABASE_PASSWORD',required:false},
  {role:'openppwr_maintenance',variable:'OPENPPWR_MAINTENANCE_DATABASE_PASSWORD',required:false},
  // Required, because a deployment without a worker cannot scan evidence — and because leaving it absent
  // would put the retention state machine back in whichever role the worker fell back to.
  {role:'openppwr_worker',variable:'OPENPPWR_WORKER_DATABASE_PASSWORD',required:true},
  {role:'openppwr_rotation',variable:'OPENPPWR_ROTATION_DATABASE_PASSWORD',required:false},
]);

const MINIMUM_PASSWORD_LENGTH=32;

// Checked after every ALTER, not assumed from the DDL. A role that has acquired an attribute since the
// migration ran — by a later migration, by an operator, or by a restored backup — is a boundary that has
// already failed, and it must fail here rather than at the first request.
//
// `rolvaliduntil` is compared by the server rather than by this process. The server's clock is the one that
// actually decides whether the login is refused; comparing against Node's would be asking the wrong clock,
// and it also sidesteps the fact that the driver renders an infinite timestamp as a JavaScript number rather
// than a Date.
async function assertRoleAttributes(client,role){
  const found=await client.query(
    `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls, rolreplication,
            rolconfig, rolconnlimit, rolvaliduntil < now() AS credential_expired
       FROM pg_roles WHERE rolname=$1`,
    [role],
  );
  if(found.rowCount!==1)throw new Error(`${role} does not exist; run the migrations first.`);
  const attributes=found.rows[0];
  const violations=[];
  if(!attributes.rolcanlogin)violations.push('cannot log in');
  if(attributes.rolsuper)violations.push('is a superuser');
  if(attributes.rolcreatedb)violations.push('may create databases');
  if(attributes.rolcreaterole)violations.push('may create roles, and could therefore grant itself anything');
  if(attributes.rolinherit)violations.push('inherits the privileges of roles granted to it');
  if(attributes.rolbypassrls)violations.push('bypasses row-level security');
  if(attributes.rolreplication)violations.push('may stream the database it is isolated within');
  // The three below are reset immediately above every call to this function. They are asserted anyway, for
  // the same reason as the attributes: the reset is a claim, and a claim about a security boundary that is
  // never read back is a claim nobody is checking.
  if(attributes.rolconfig?.length)violations.push(`carries role-level settings this deployment never sets (${attributes.rolconfig.join(', ')})`);
  if(attributes.rolconnlimit===0)violations.push('may open no connections at all');
  if(attributes.credential_expired)violations.push('has a password expiry in the past, which disables password authentication');
  if(violations.length)throw new Error(`${role} role attributes do not meet the runtime policy: ${violations.join('; ')}.`);
}

// Provisioning is authoritative, or it is not provisioning.
//
// `ALTER ROLE ... LOGIN PASSWORD` sets exactly two things. Three other pieces of role state survive it, none
// of them visible in the DDL below, and each one can make this function's report of success untrue. Because
// they survive, the resulting state depended on history rather than on this run — so "re-provision to repair
// the deployment" was not true, which is the whole point of the step existing.
//
//   `rolconfig` is per-role `ALTER ROLE ... SET`, and it is the one that is not merely untidy. A superuser
//   can pin a parameter onto a role that the role is itself forbidden to set. Measured on PostgreSQL 18:
//   `ALTER ROLE openppwr_app SET session_replication_role = 'replica'` is accepted, the role receives it at
//   every subsequent login, and that same role's own `SET` of that same parameter is refused with 42501.
//   Whatever privilege boundary the parameter represents, the role is on the wrong side of it and cannot put
//   itself back. Nothing in this schema sets a role-level parameter — every SECURITY DEFINER function pins
//   its own `search_path` in its own definition, which is where that belongs — so empty is the only correct
//   value of `rolconfig` here and `RESET ALL` is the entire repair.
//
//   `VALID UNTIL` in the past disables password authentication outright. Measured: after a re-provision that
//   returned success and named the role as configured, `openppwr_app` could not connect at all — "User has
//   an expired password". The installer is issuing this credential in this run; an expiry that has already
//   passed contradicts the operation being performed, so it is cleared.
//
// `CONNECTION LIMIT` is deliberately not in that list, and is handled below instead.
async function resetProvisionedState(client,role){
  const found=await client.query('SELECT rolconnlimit FROM pg_roles WHERE rolname=$1',[role]);
  if(found.rowCount!==1)throw new Error(`${role} does not exist; run the migrations first.`);

  const statements=['ALTER ROLE %I RESET ALL',"ALTER ROLE %I VALID UNTIL 'infinity'"];

  // The one piece of role state an operator may legitimately own, so it is the one this function refuses to
  // take from them. Capping openppwr_app at, say, forty connections to protect a small cluster from a
  // misconfigured pool is a real and sensible operational decision, and a provisioner that silently reset it
  // to unlimited would quietly undo that decision on every run — including the runs an operator makes for
  // unrelated reasons, such as rotating a password.
  //
  // Zero is not that. Zero is not a cap, it is "this principal may not connect", and it cannot be what an
  // operator means while supplying that same principal's password in the same invocation. The supported way
  // to disable a principal here is to omit its password, which retires the role outright a few lines below —
  // a mechanism that is explicit, reported in the return value, and does not masquerade as a working
  // deployment. So a zero left behind by a previous state is repaired, a positive limit is preserved, and
  // the assertion afterwards refuses zero rather than accepting the repair on faith.
  if(found.rows[0].rolconnlimit===0)statements.push('ALTER ROLE %I CONNECTION LIMIT -1');

  for(const template of statements){
    // The role name reaches the DDL through PostgreSQL's own `%I`, so it is quoted by the server rather than
    // by a rule written here. These names are internal constants today; the quoting is what keeps that from
    // being the reason it is safe.
    const formatted=await client.query('SELECT format($1::text, $2::text) AS ddl',[template,role]);
    await client.query(formatted.rows[0].ddl);
  }
}

// NOINHERIT stops implicit inheritance. Only the absence of membership stops SET ROLE, so a request-serving
// connection that is a member of a privileged role can still become it on demand.
async function assertNoMembership(client){
  const memberships=await client.query(
    `SELECT r.rolname AS member, g.rolname AS granted
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = ANY($1)`,
    [PRINCIPALS.map((principal)=>principal.role)],
  );
  if(memberships.rowCount>0){
    const described=memberships.rows.map((row)=>`${row.member} is a member of ${row.granted}`).join('; ');
    throw new Error(`runtime principals must not be members of any role: ${described}.`);
  }
}

export async function prepareRuntime(environment=process.env){
  const connectionString=environment.OPENPPWR_MIGRATION_DATABASE_URL;
  if(!connectionString)throw new Error('OPENPPWR_MIGRATION_DATABASE_URL is required.');

  const configured=[];
  const passwords=new Map();
  for(const principal of PRINCIPALS){
    const password=environment[principal.variable];
    if(!password){
      if(principal.required)throw new Error(`${principal.variable} is required.`);
      continue;
    }
    if(password.length<MINIMUM_PASSWORD_LENGTH)throw new Error(`${principal.variable} must contain at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
    // Distinct per role. Reusing one password across principals leaves the grants separated and the
    // capability shared, which is the appearance of a boundary rather than a boundary.
    const reused=passwords.get(password);
    if(reused)throw new Error(`${principal.variable} repeats the password of ${reused}; each database principal needs its own.`);
    passwords.set(password,principal.variable);
    configured.push({...principal,password});
  }

  await migrate(connectionString);
  // Bounded exactly as the migration client is, and for the same reason: a raw Client has no checkout queue
  // to starve, and an installer step that waits forever on a half-open connection reports nothing at all.
  // See `migrationConnectTimeoutMs` for the measurement behind the default.
  const client=new Client({connectionString,connectionTimeoutMillis:migrationConnectTimeoutMs()});
  await client.connect();
  try{
    // A principal whose password is absent is retired, not skipped. Skipping left the role able to log in
    // with the credential a previous demonstration configure gave it — so removing the variables removed the
    // deployment's *use* of the credential and not the credential itself. The server refuses to
    // start when a privileged URL is present in production; this makes the login itself impossible.
    const retired=[];
    for(const principal of PRINCIPALS){
      if(configured.some((entry)=>entry.role===principal.role))continue;
      const exists=await client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[principal.role]);
      if(exists.rowCount!==1||!exists.rows[0].rolcanlogin)continue;
      // Through `%I` like every other identifier here. A retired role keeps whatever `rolconfig` it had, and
      // deliberately so: it cannot log in and cannot hold a session, so a session default on it configures
      // nothing. Should an operator later supply its password, `resetProvisionedState` clears it before the
      // role becomes usable again.
      const formatted=await client.query(
        'SELECT format(\'ALTER ROLE %I NOLOGIN PASSWORD NULL\', $1::text) AS ddl',
        [principal.role],
      );
      await client.query(formatted.rows[0].ddl);
      retired.push(principal.role);
    }
    for(const principal of configured){
      // Before the credential, not after: the role must not be able to log in during the window in which its
      // inherited session defaults are still in force.
      await resetProvisionedState(client,principal.role);
      // The password reaches PostgreSQL as a bound parameter and is quoted by the server, so it is never
      // assembled into SQL here and never appears in a process argument.
      const formatted=await client.query(
        'SELECT format(\'ALTER ROLE %I LOGIN PASSWORD %L\', $1::text, $2::text) AS ddl',
        [principal.role,principal.password],
      );
      await client.query(formatted.rows[0].ddl);
      await assertRoleAttributes(client,principal.role);
    }
    await assertNoMembership(client);
    return {configured:configured.map((principal)=>principal.role),retired};
  }finally{await client.end();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareRuntime().then((result)=>console.log(`OpenPPWR database prepared. Principals configured: ${result.configured.join(', ')}.`)).catch((error)=>{console.error(error.message);process.exitCode=1;});
