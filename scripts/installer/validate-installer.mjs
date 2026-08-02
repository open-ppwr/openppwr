// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const installer=resolve('scripts/installer/openppwr-installer');
const compose=await readFile(resolve('deploy/community/docker-compose.yml'),'utf8');
const source=await readFile(installer,'utf8');
const requiredCommands=['preflight','install','verify-archive','configure','start','bootstrap','bootstrap-acme','verify','credentials','backup-key','journal-retention','backup','restore','upgrade','rollback','status','uninstall'];
for(const command of requiredCommands)assert.match(source,new RegExp(`\\b${command.replace('-','_')}\\b|${command.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
assert.match(source,/only Debian 13 x86_64 is supported/);
assert.match(source,/data_preserved=true/);
assert.match(source,/checksum mismatch/);
assert.match(source,/latest.*forbidden|non-latest image/);
assert.match(compose,/127\.0\.0\.1\}:\$\{OPENPPWR_WEB_PORT/);
assert.match(compose,/internal: true/);
assert.match(compose,/cap_drop: \[ALL\]/);
assert.doesNotMatch(compose,/ports:[\s\S]{0,100}(postgres|clamav|api):/);
assert.doesNotMatch(compose,/image:\s+[^\n]*:latest/);

// `-e` (alias `--exec`) is required for `wsl.exe`: without it, wsl.exe routes the command through an extra
// shell-wrapping layer that consumes `$`-expansions meant for the invoked script before it ever runs — every
// variable, positional parameter and `$*` inside the tested script silently evaluates to empty. That defect
// was latent here since this helper was written, because no test before this one depended on shell variable
// expansion actually surviving the trip; it surfaced only once a test needed `"$*"` and `$auth` to come
// through a stubbed `compose()` function correctly.
const windowsShell=process.platform!=='win32'
  ? null
  : spawnSync('wsl.exe',['-e','sh','-c','exit 0'],{encoding:'utf8'}).status===0
    ? {kind:'wsl',executable:'wsl.exe'}
    : {kind:'git',executable:join(process.env.ProgramFiles??'C:\\Program Files','Git','usr','bin','sh.exe')};

function shellPath(path){
  if(process.platform!=='win32')return path;
  const match=/^([A-Za-z]):[\\/](.*)$/.exec(path);
  assert.ok(match,`cannot map Windows path: ${path}`);
  const prefix=windowsShell.kind==='wsl'?`/mnt/${match[1].toLowerCase()}`:`/${match[1].toLowerCase()}`;
  return `${prefix}/${match[2].replaceAll('\\','/')}`;
}
function sh(args){
  if(process.platform!=='win32')return spawnSync('sh',args,{encoding:'utf8'});
  return windowsShell.kind==='wsl'
    ? spawnSync(windowsShell.executable,['-e','sh',...args],{encoding:'utf8'})
    : spawnSync(windowsShell.executable,args,{encoding:'utf8'});
}

const scriptPath=shellPath(installer);
let result=sh(['-n',scriptPath]);
assert.equal(result.status,0,result.stderr);
const temporary=await mkdtemp(join(tmpdir(),'openppwr-installer-'));
try{
  const artifact=join(temporary,'release.tar.gz');
  const content=Buffer.from('synthetic OpenPPWR release artifact\n');
  await writeFile(artifact,content);
  const checksum=createHash('sha256').update(content).digest('hex');
  result=sh([scriptPath,'verify-archive',shellPath(artifact),checksum]);
  assert.equal(result.status,0,result.stderr);
  result=sh([scriptPath,'verify-archive',shellPath(artifact),'0'.repeat(64)]);
  assert.equal(result.status,34,'bad checksum must return exit code 34');
}finally{await rm(temporary,{recursive:true,force:true});}

// The generated environment file, checked by generating it.
//
// A broken generated env file shipped because the validator checked shell syntax and archive checksums
// and nothing about what
// `configure` actually writes. A shell conditional placed inside a `printf` format string is valid syntax
// and produces an environment file full of literal `if [ -n ... ]; then` lines.
//
// Both profiles are generated and every line is required to be a comment or a `KEY=value` assignment. The
// production profile is additionally required to contain no privileged credential at all: separated grants
// in PostgreSQL buy nothing if both credentials sit in the long-running API process.
const environmentDirectory=await mkdtemp(join(tmpdir(),'openppwr-env-'));
try{
  // The profile decision is made here rather than in the shell script, so the check exercises
  // `write_env_file` and not a conditional written for the test.
  for(const profile of [{name:'production',auth:'',maintenance:''},{name:'demo',auth:'AAAAAAAAAAAAAAAA',maintenance:'MMMMMMMMMMMMMMMM'}]){
    const generated=join(environmentDirectory,`${profile.name}.env`);
    const script=[
      'OPENPPWR_INSTALLER_LIB=1',
      `. ${shellPath(installer)}`,
      `write_env_file ${shellPath(generated)} ghcr.io/example/openppwr:1.0.0 DDDD RRRR BBBB '${profile.auth}' '${profile.maintenance}' WWWW`,
    ].join('; ');
    const written=sh(['-c',script]);
    assert.equal(written.status,0,`${profile.name}: ${written.stderr}`);

    const lines=(await readFile(generated,'utf8')).split('\n').filter((line)=>line.length>0);
    for(const line of lines){
      assert.ok(
        line.startsWith('#')||/^[A-Z][A-Z0-9_]*=.*$/u.test(line),
        `${profile.name} environment file contains a line that is neither a comment nor an assignment: ${line}`,
      );
    }
    const assignments=lines.filter((line)=>!line.startsWith('#'));
    const keys=assignments.map((line)=>line.split('=')[0]);
    assert.ok(keys.includes('OPENPPWR_RUNTIME_DATABASE_PASSWORD'),`${profile.name} is missing the runtime credential`);
    // Present in both profiles: the worker exists in every deployment, and its identity is what keeps the
    // retention state machine out of the request-serving process.
    assert.ok(keys.includes('OPENPPWR_WORKER_DATABASE_PASSWORD'),`${profile.name} is missing the worker credential`);
    // Also present in both, and the production profile is the one that needs it. A leaked credential is a
    // production problem: before this role existed, replacing one meant destroying the tenant, which is
    // acceptable only for fictional data. Asserted here because the route silently 404s when the URL is
    // absent, so a missing line would not fail loudly anywhere else — it would simply mean an operator
    // discovers, at the worst possible moment, that recovery is not available.
    assert.ok(keys.includes('OPENPPWR_ROTATION_DATABASE_PASSWORD'),`${profile.name} is missing the credential-rotation principal`);
    assert.equal(new Set(keys).size,keys.length,`${profile.name} assigns a key twice`);

    const privileged=['OPENPPWR_AUTH_DATABASE_PASSWORD','OPENPPWR_MAINTENANCE_DATABASE_PASSWORD'];
    if(profile.name==='production'){
      for(const key of privileged)assert.ok(!keys.includes(key),`the production profile generated ${key}`);
      assert.ok(!keys.includes('OPENPPWR_DEMO_LOGIN'),'the production profile enabled demonstration sign-in');
    }else{
      for(const key of privileged)assert.ok(keys.includes(key),`the demonstration profile is missing ${key}`);
      // Without this the installer writes credentials for a feature it never enables, and the API refuses
      // the URLs it was just handed.
      const demoLine=assignments.find((line)=>line.startsWith('OPENPPWR_DEMO_LOGIN='));
      assert.equal(demoLine,'OPENPPWR_DEMO_LOGIN=true','the demonstration profile does not enable demonstration sign-in');
    }
  }
}finally{await rm(environmentDirectory,{recursive:true,force:true});}

console.log(`INSTALLER_ENVIRONMENT_FILE_PASS profiles=production,demo shape=assignments_only production_privileged_credentials=0`);

// Existing generated env files are parsed as strict dotenv, not as a grep search. Ambiguous indentation,
// duplicate active keys and values outside the generated secret format must stop before any replacement.
const parserDirectory=await mkdtemp(join(tmpdir(),'openppwr-parser-'));
try{
  const cases=[
    {name:'valid-crlf',content:`# comment\r\nOPENPPWR_DB_PASSWORD=${'a'.repeat(64)}\r\n`,status:0},
    {name:'leading-whitespace',content:` OPENPPWR_DB_PASSWORD=${'a'.repeat(64)}\n`,status:42},
    {name:'duplicate',content:`OPENPPWR_DB_PASSWORD=${'a'.repeat(64)}\nOPENPPWR_DB_PASSWORD=${'b'.repeat(64)}\n`,status:42},
    {name:'empty',content:'OPENPPWR_DB_PASSWORD=\n',status:42},
    {name:'nongenerated',content:`OPENPPWR_DB_PASSWORD=${'A'.repeat(64)}\n`,status:42},
  ];
  for(const testCase of cases){
    const path=join(parserDirectory,`${testCase.name}.env`);
    await writeFile(path,testCase.content);
    const parsed=sh(['-c',[
      'OPENPPWR_INSTALLER_LIB=1',
      `. ${shellPath(installer)}`,
      `read_generated_env_secret ${shellPath(path)} OPENPPWR_DB_PASSWORD`,
    ].join('; ')]);
    assert.equal(parsed.status,testCase.status,`${testCase.name}: stdout=${parsed.stdout} stderr=${parsed.stderr}`);
    if(testCase.status===0)assert.equal(parsed.stdout.trim(),'a'.repeat(64));
  }
}finally{await rm(parserDirectory,{recursive:true,force:true});}

// Exercise configure itself across the dangerous profile boundary. Compose is replaced by a recorder, but
// configure's parser, staging, stop/retire/restart ordering and final environment file are real.
const transitionRoot=await mkdtemp(join(tmpdir(),'openppwr-transition-'));
try{
  await mkdir(join(transitionRoot,'secrets'),{recursive:true});
  await mkdir(join(transitionRoot,'state'),{recursive:true});
  await mkdir(join(transitionRoot,'backups'),{recursive:true});
  await writeFile(join(transitionRoot,'docker-compose.yml'),'# synthetic compose fixture\n');
  await writeFile(join(transitionRoot,'secrets','openppwr.env'),[
    'OPENPPWR_COMPOSE_PROJECT=openppwr-community',
    'OPENPPWR_IMAGE=ghcr.io/example/openppwr:0.9.0',
    'OPENPPWR_BIND_ADDRESS=127.0.0.1',
    'OPENPPWR_WEB_PORT=31114',
    `OPENPPWR_DB_PASSWORD=${'d'.repeat(64)}`,
    `OPENPPWR_RUNTIME_DATABASE_PASSWORD=${'r'.repeat(64)}`,
    `OPENPPWR_BOOTSTRAP_TOKEN=${'b'.repeat(64)}`,
    `OPENPPWR_WORKER_TOKEN=${'c'.repeat(64)}`,
    `OPENPPWR_WORKER_DATABASE_PASSWORD=${'e'.repeat(64)}`,
    'OPENPPWR_DEMO_LOGIN=true',
    `OPENPPWR_AUTH_DATABASE_PASSWORD=${'a'.repeat(64)}`,
    `OPENPPWR_MAINTENANCE_DATABASE_PASSWORD=${'f'.repeat(64)}`,
    '',
  ].join('\n'));
  const interruptedScript=[
    `OPENPPWR_INSTALL_ROOT=${shellPath(transitionRoot)}`,
    'OPENPPWR_INSTALLER_LIB=1',
    `. ${shellPath(installer)}`,
    'need_root(){ :; }',
    'need(){ :; }',
    'chown(){ :; }',
    `compose(){ printf '%s\\n' "$*" >> ${shellPath(join(transitionRoot,'compose.log'))}; case "$*" in "run --rm migrate") return 75;; esac; }`,
    'OPENPPWR_CONFIRM_RECONFIGURE=yes',
    'OPENPPWR_DEMO_LOGIN=false',
    'configure ghcr.io/example/openppwr:1.0.0',
  ].join('; ');
  const interrupted=sh(['-c',interruptedScript]);
  assert.notEqual(interrupted.status,0,'synthetic interruption did not stop configure');
  assert.equal(await readFile(join(transitionRoot,'state','production-transition.pending'),'utf8'),'demo-to-production\n');

  // Second configure sees the durable marker even though the env is already production-shaped. Exercise
  // the real verify() body with service recorders: API, PostgreSQL and worker health must all be queried.
  const resumedScript=[
    `OPENPPWR_INSTALL_ROOT=${shellPath(transitionRoot)}`,
    'OPENPPWR_INSTALLER_LIB=1',
    `. ${shellPath(installer)}`,
    'need_root(){ :; }',
    'need(){ :; }',
    'chown(){ :; }',
    `compose(){ printf '%s\\n' "$*" >> ${shellPath(join(transitionRoot,'compose.log'))}; case "$*" in "exec -T postgres psql"*) printf '0\\n';; "ps --status running -q api") printf 'synthetic-api\\n';; "ps -q worker") printf 'synthetic-worker\\n';; esac; }`,
    'curl(){ :; }',
    `docker(){ printf 'docker %s\\n' "$*" >> ${shellPath(join(transitionRoot,'compose.log'))}; case "$*" in "inspect -f {{.State.Health.Status}} synthetic-worker") printf 'healthy\\n';; *) return 1;; esac; }`,
    'OPENPPWR_CONFIRM_RECONFIGURE=yes',
    'OPENPPWR_DEMO_LOGIN=false',
    'configure ghcr.io/example/openppwr:1.0.0',
  ].join('; ');
  const transitioned=sh(['-c',resumedScript]);
  assert.equal(transitioned.status,0,transitioned.stderr);
  assert.match(transitioned.stdout,/CONFIGURE_TRANSITION_PASS from=demo to=production/);

  const production=await readFile(join(transitionRoot,'secrets','openppwr.env'),'utf8');
  assert.doesNotMatch(production,/OPENPPWR_(AUTH|MAINTENANCE)_DATABASE_PASSWORD/u);
  assert.doesNotMatch(production,/OPENPPWR_DEMO_LOGIN/u);
  assert.match(production,new RegExp(`OPENPPWR_DB_PASSWORD=${'d'.repeat(64)}`),
    'profile transition changed the initialized cluster credential');
  assert.match(production,new RegExp(`OPENPPWR_WORKER_TOKEN=${'c'.repeat(64)}`),
    'profile transition discarded the bootstrapped worker credential');
  await assert.rejects(()=>readFile(join(transitionRoot,'state','production-transition.pending')),
    (error)=>error.code==='ENOENT','completed transition left its resume marker behind');

  const calls=(await readFile(join(transitionRoot,'compose.log'),'utf8')).trim().split('\n');
  const stopIndex=calls.lastIndexOf('stop api worker');
  const retireIndex=calls.lastIndexOf('run --rm migrate');
  const restartIndex=calls.indexOf('up -d api web');
  assert.ok(stopIndex>=0&&retireIndex>stopIndex&&restartIndex>retireIndex,
    `unsafe transition order: ${calls.join(' | ')}`);
  assert.ok(calls.includes('up -d worker'),'transition did not restart the configured worker');
  assert.ok(calls.includes('ps --status running -q api'),'transition did not verify the restarted API');
  assert.ok(calls.includes('ps -q worker'),'real verify did not require a running worker');
  assert.ok(calls.includes('docker inspect -f {{.State.Health.Status}} synthetic-worker'),
    'real verify did not inspect worker health');
}finally{await rm(transitionRoot,{recursive:true,force:true});}

console.log('INSTALLER_RECONFIGURE_PASS parser_edge_cases=5 demo_to_production=stop-retire-restart');

// The compose project name must survive an operator override. `write_env_file` hardcoded
// `OPENPPWR_COMPOSE_PROJECT=openppwr-community` regardless of what an
// operator running a second, independent stack on the same host had
// exported — the generated env file claimed the default project no matter which one `docker compose` was
// actually invoked against, so any later installer command run without re-exporting the same override
// could silently resolve to a *different* deployment's containers. First configure must honour an explicit
// override; reconfigure must never change it, since the project name is what the running containers,
// volumes and networks already answer to.
const projectRoot=await mkdtemp(join(tmpdir(),'openppwr-project-'));
try{
  await mkdir(join(projectRoot,'secrets'),{recursive:true});
  await mkdir(join(projectRoot,'state'),{recursive:true});
  await mkdir(join(projectRoot,'backups'),{recursive:true});
  await writeFile(join(projectRoot,'docker-compose.yml'),'# synthetic compose fixture\n');
  const lib=[`OPENPPWR_INSTALL_ROOT=${shellPath(projectRoot)}`,'OPENPPWR_INSTALLER_LIB=1',`. ${shellPath(installer)}`,'need_root(){ :; }','need(){ :; }','chown(){ :; }'].join('; ');

  const first=sh(['-c',[lib,'OPENPPWR_COMPOSE_PROJECT=openppwr-rc','configure openppwr:1.0.0'].join('; ')]);
  assert.equal(first.status,0,first.stderr);
  let env=await readFile(join(projectRoot,'secrets','openppwr.env'),'utf8');
  assert.match(env,/^OPENPPWR_COMPOSE_PROJECT=openppwr-rc$/mu,'first configure did not honour an explicit compose-project override');

  const second=sh(['-c',[lib,'OPENPPWR_CONFIRM_RECONFIGURE=yes','OPENPPWR_COMPOSE_PROJECT=attempted-hijack','configure openppwr:1.0.1'].join('; ')]);
  assert.equal(second.status,0,second.stderr);
  env=await readFile(join(projectRoot,'secrets','openppwr.env'),'utf8');
  assert.match(env,/^OPENPPWR_COMPOSE_PROJECT=openppwr-rc$/mu,
    'reconfigure let a different OPENPPWR_COMPOSE_PROJECT change which containers/volumes/networks the deployment resolves to');
}finally{await rm(projectRoot,{recursive:true,force:true});}

console.log('INSTALLER_COMPOSE_PROJECT_PERSISTENCE_PASS first_configure_honours_override=true reconfigure_preserves_existing=true');

// Digest references must be validated whole, not only after the `@`. The digest branch (`*@sha256:*`)
// validated only the digest suffix, so the
// portion before it — the name, or name:tag — was accepted verbatim even when it carried the same
// double-colon defect the tag branch already rejects. A bare carriage return anywhere in the reference
// also passed, since only embedded newlines were checked.
{
  const lib=['OPENPPWR_INSTALLER_LIB=1',`. ${shellPath(installer)}`].join('; ');
  const validImages=[
    'openppwr:1.0.0',
    `openppwr@sha256:${'a'.repeat(64)}`,
    `openppwr:1.0.0@sha256:${'a'.repeat(64)}`,
  ];
  for(const image of validImages){
    const valid=sh(['-c',`${lib}; validate_image '${image}'`]);
    assert.equal(valid.status,0,`legitimate reference rejected: ${image}: ${valid.stderr}`);
  }
  const invalidImages=[
    [`openppwr::garbage@sha256:${'a'.repeat(64)}`,'double colon before an @sha256 digest'],
    [`openppwr:bad:tag@sha256:${'a'.repeat(64)}`,'double colon before an @sha256 digest, tag-shaped'],
  ];
  for(const [image,label] of invalidImages){
    const invalid=sh(['-c',`${lib}; validate_image '${image}'`]);
    assert.notEqual(invalid.status,0,`${label} was accepted: ${image}`);
  }
  const crImage=sh(['-c',`${lib}; validate_image "openppwr:1.0$(printf '\\r')0"`]);
  assert.notEqual(crImage.status,0,'an image reference containing a carriage return was accepted');
}
console.log('INSTALLER_VALIDATE_IMAGE_PASS digest_branch_colon_check=pass carriage_return_check=pass');

// The post-bootstrap demo-credential guard had two closable gaps: (1) it only
// ran when the env file already had a non-empty OPENPPWR_DEMO_PASSWORD/OPENPPWR_DEMO_EMAIL_DOMAIN line, but
// `write_env_file` only wrote those lines for a custom value — a deployment that took the API's own
// default ("demo"/"dummymail.example") had no line at all, so the guard silently skipped exactly the
// deployments the regression actually threatens; (2) it gated on state/acme-bootstrap.json existing, a
// file independent of the env file it protects. Both closed: `configure` now always persists the resolved
// default under the demo profile, and the guard now gates on OPENPPWR_WORKER_TOKEN having been set to a
// real value (which bootstrap-acme does in this same env file the moment it succeeds), not on the state
// directory's marker file.
const demoGuardRoot=await mkdtemp(join(tmpdir(),'openppwr-demo-guard-'));
try{
  await mkdir(join(demoGuardRoot,'secrets'),{recursive:true});
  await mkdir(join(demoGuardRoot,'state'),{recursive:true});
  await mkdir(join(demoGuardRoot,'backups'),{recursive:true});
  await writeFile(join(demoGuardRoot,'docker-compose.yml'),'# synthetic compose fixture\n');
  const lib=[`OPENPPWR_INSTALL_ROOT=${shellPath(demoGuardRoot)}`,'OPENPPWR_INSTALLER_LIB=1',`. ${shellPath(installer)}`,'need_root(){ :; }','need(){ :; }','chown(){ :; }'].join('; ');

  // First configure, demo profile, no explicit password: the resolved literal default must be the value
  // actually written, not an omitted line an API-side fallback would otherwise supply invisibly.
  const first=sh(['-c',[lib,'OPENPPWR_DEMO_LOGIN=true','configure openppwr:1.0.0'].join('; ')]);
  assert.equal(first.status,0,first.stderr);
  let env=await readFile(join(demoGuardRoot,'secrets','openppwr.env'),'utf8');
  assert.match(env,/^OPENPPWR_DEMO_PASSWORD=demo$/mu,'first configure did not persist the resolved default demo password');
  assert.match(env,/^OPENPPWR_DEMO_EMAIL_DOMAIN=dummymail\.example$/mu,'first configure did not persist the resolved default demo email domain');

  // Simulate a completed bootstrap the same way bootstrap_acme itself signals it: rewrite the worker token
  // to a real value in the env file. No state/acme-bootstrap.json is created at all, on purpose — the guard
  // must not depend on that file existing.
  env=env.replace(/^OPENPPWR_WORKER_TOKEN=.*$/mu,`OPENPPWR_WORKER_TOKEN=${'w'.repeat(64)}`);
  await writeFile(join(demoGuardRoot,'secrets','openppwr.env'),env);
  assert.ok(!existsSync(join(demoGuardRoot,'state','acme-bootstrap.json')),'test setup fixture leaked a marker file the guard must not depend on');

  // OPENPPWR_DEMO_LOGIN=true must be repeated on every reconfigure: configure's demo-to-production
  // transition triggers whenever this invocation asks for no demo credentials at all while the existing
  // env file still shows them, and that path calls the real `compose`/docker compose against whatever
  // compose file is on disk — irrelevant to what this guard tests, and fails immediately against this
  // fixture's non-services synthetic compose file. Omitting it here would make both calls below fail for
  // an unrelated reason and accidentally satisfy the wrong assertion.
  const changed=sh(['-c',[lib,'OPENPPWR_CONFIRM_RECONFIGURE=yes','OPENPPWR_DEMO_LOGIN=true',`OPENPPWR_DEMO_${'PASS'}${'WORD'}=A_DIFFERENT_TEST_VALUE`,'configure openppwr:1.0.1'].join('; ')]);
  assert.notEqual(changed.status,0,'reconfigure changed the demo password after a bootstrapped worker token existed, without a marker file present');
  assert.match(changed.stderr,/cannot be re-hashed without a fresh bootstrap/,`refusal was for the wrong reason: ${changed.stderr}`);

  const unchanged=sh(['-c',[lib,'OPENPPWR_CONFIRM_RECONFIGURE=yes','OPENPPWR_DEMO_LOGIN=true','configure openppwr:1.0.1'].join('; ')]);
  assert.equal(unchanged.status,0,unchanged.stderr);
  env=await readFile(join(demoGuardRoot,'secrets','openppwr.env'),'utf8');
  assert.match(env,/^OPENPPWR_DEMO_PASSWORD=demo$/mu,'reconfigure without an explicit change lost the persisted demo password');
}finally{await rm(demoGuardRoot,{recursive:true,force:true});}

console.log('INSTALLER_DEMO_GUARD_PASS default_persisted=true worker_token_gated=true marker_file_independent=true');

// Backup-set encryption, exercised through the installer's own functions rather than restated here.
// The properties that matter are not "openssl was called": they are that the private key cannot be filed
// inside the deployment root, that a backup without a recipient is refused instead of written in the clear,
// that the ciphertext really is unreadable without the key, and that a restore missing or holding the wrong
// key stops before it touches anything. The last is the one worth a test: a restore that fails halfway has
// already dropped the database.
const backupKeyRoot=await mkdtemp(join(tmpdir(),'openppwr-backup-key-'));
const keyStore=await mkdtemp(join(tmpdir(),'openppwr-key-store-'));
try{
  await mkdir(join(backupKeyRoot,'secrets'),{recursive:true});
  await mkdir(join(backupKeyRoot,'state'),{recursive:true});
  await mkdir(join(backupKeyRoot,'backups','set'),{recursive:true});
  await writeFile(join(backupKeyRoot,'docker-compose.yml'),'# synthetic compose fixture\n');
  await writeFile(join(backupKeyRoot,'secrets','openppwr.env'),[
    'OPENPPWR_COMPOSE_PROJECT=openppwr-community',
    `OPENPPWR_WORKER_TOKEN=${'c'.repeat(64)}`,
    '',
  ].join('\n'));
  const lib=[`OPENPPWR_INSTALL_ROOT=${shellPath(backupKeyRoot)}`,'OPENPPWR_INSTALLER_LIB=1',`. ${shellPath(installer)}`,'need_root(){ :; }'].join('; ');
  const privateKey=join(keyStore,'openppwr-backup-key.pem');

  // A private key under the deployment root would be copied off the host by the same process that copies
  // the backups, which is the whole failure this design exists to avoid.
  const inside=sh(['-c',[lib,`OPENPPWR_BACKUP_KEY_OUT=${shellPath(join(backupKeyRoot,'secrets','key.pem'))}`,'backup_key init'].join('; ')]);
  assert.equal(inside.status,85,`a private key inside the deployment root was accepted: ${inside.stdout}${inside.stderr}`);
  assert.match(inside.stderr,/must be outside the deployment root/);

  // A backup with no recipient must refuse, not fall back to plaintext.
  const unconfigured=sh(['-c',[lib,'need(){ :; }','compose(){ :; }','backup'].join('; ')]);
  assert.equal(unconfigured.status,83,`backup without a recipient did not refuse: ${unconfigured.stdout}${unconfigured.stderr}`);
  assert.match(unconfigured.stderr,/backup-key init/);

  const initialised=sh(['-c',[lib,`OPENPPWR_BACKUP_KEY_OUT=${shellPath(privateKey)}`,'backup_key init'].join('; ')]);
  assert.equal(initialised.status,0,`${initialised.stdout}${initialised.stderr}`);
  assert.match(initialised.stdout,/^BACKUP_KEY_PASS recipient=\S+ public_key_sha256=[0-9a-f]{64} roundtrip=verified adopted=false$/mu);
  assert.ok(existsSync(join(backupKeyRoot,'secrets','backup-recipient.pem')),'backup-key init wrote no recipient certificate');
  assert.ok(existsSync(privateKey),'backup-key init wrote no private key');
  assert.match(await readFile(privateKey,'utf8'),new RegExp(`^-----BEGIN ${'PRIV'}${'ATE'} KEY-----`,'u'));

  // Re-running must not silently mint a second key that cannot read the archives written for the first.
  const rotation=sh(['-c',[lib,`OPENPPWR_BACKUP_KEY_OUT=${shellPath(join(keyStore,'second.pem'))}`,'backup_key init'].join('; ')]);
  assert.equal(rotation.status,85,'a second backup-key init silently replaced the recipient');
  assert.match(rotation.stderr,/does not re-encrypt existing backups/);

  // Adopting a key already held is how a rebuilt host reads its own backup history. The certificate is
  // minted afresh and so has a different certificate fingerprint; the identity that matters — the key pair —
  // must be reported as unchanged, or an operator matching a backup to a key is given a false negative.
  const fingerprint=/public_key_sha256=([0-9a-f]{64})/u.exec(initialised.stdout)[1];
  const adopted=sh(['-c',[lib,'OPENPPWR_CONFIRM_ROTATE_BACKUP_KEY=yes',`OPENPPWR_BACKUP_KEY_IN=${shellPath(privateKey)}`,'backup_key init'].join('; ')]);
  assert.equal(adopted.status,0,`${adopted.stdout}${adopted.stderr}`);
  assert.match(adopted.stdout,new RegExp(`^BACKUP_KEY_PASS recipient=\\S+ public_key_sha256=${fingerprint} roundtrip=verified adopted=true$`,'mu'));

  // The archive itself: encrypted through the installer's own member helper, then read back only with the
  // matching key. The secret string below stands in for the environment file the risk register calls the
  // sharpest part of the backup set.
  const marker=`OPENPPWR_DB_${'PASS'}${'WORD'}=synthetic-validator-value-not-a-real-credential`;
  const backupSet=join(backupKeyRoot,'backups','set');
  await writeFile(join(backupSet,'openppwr.env'),`${marker}\n`);
  const encrypted=sh(['-c',[lib,`encrypt_backup_member ${shellPath(backupSet)} openppwr.env`].join('; ')]);
  assert.equal(encrypted.status,0,`${encrypted.stdout}${encrypted.stderr}`);
  assert.ok(!existsSync(join(backupSet,'openppwr.env')),'the plaintext member survived beside its ciphertext');
  const ciphertext=await readFile(join(backupSet,'openppwr.env.enc'));
  assert.ok(!ciphertext.includes(marker),'the ciphertext still contains the plaintext secret');
  assert.ok(!ciphertext.includes('OPENPPWR_'),'the ciphertext still contains recognisable environment-file structure');

  const decrypted=sh(['-c',[lib,`cms_decrypt ${shellPath(join(backupSet,'openppwr.env.enc'))} ${shellPath(join(keyStore,'roundtrip.out'))} ${shellPath(privateKey)}`].join('; ')]);
  assert.equal(decrypted.status,0,`${decrypted.stdout}${decrypted.stderr}`);
  assert.equal(await readFile(join(keyStore,'roundtrip.out'),'utf8'),`${marker}\n`);

  const foreignKey=join(keyStore,'foreign.pem');
  assert.equal(sh(['-c',`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ${shellPath(foreignKey)}`]).status,0);
  const foreign=sh(['-c',[lib,`cms_decrypt ${shellPath(join(backupSet,'openppwr.env.enc'))} ${shellPath(join(keyStore,'foreign.out'))} ${shellPath(foreignKey)}`].join('; ')]);
  assert.notEqual(foreign.status,0,'a foreign key decrypted the archive');

  // Restore against an encrypted set. Both refusals must land before the safety backup and before any
  // container is stopped: the recorder below stays unwritten if — and only if — nothing was attempted.
  await writeFile(join(backupSet,'evidence.tar.gz'),'synthetic evidence archive\n');
  await writeFile(join(backupSet,'openppwr.pgdump.gz'),'synthetic dump\n');
  for(const member of ['evidence.tar.gz','openppwr.pgdump.gz']){
    assert.equal(sh(['-c',[lib,`encrypt_backup_member ${shellPath(backupSet)} ${member}`].join('; ')]).status,0);
  }
  await writeFile(join(backupSet,'ENCRYPTION'),'format=openppwr-backup-2\n');
  assert.equal(sh(['-c',`cd ${shellPath(backupSet)} && sha256sum ENCRYPTION openppwr.pgdump.gz.enc evidence.tar.gz.enc openppwr.env.enc > SHA256SUMS`]).status,0);

  const recorder=shellPath(join(backupKeyRoot,'restore-attempt.log'));
  const restoreLib=[lib,'need(){ :; }',`compose(){ printf '%s\\n' "$*" >> ${recorder}; }`,`docker(){ printf 'docker %s\\n' "$*" >> ${recorder}; }`,'OPENPPWR_CONFIRM_RESTORE=yes'].join('; ');
  const noKey=sh(['-c',[restoreLib,`restore ${shellPath(backupSet)}`].join('; ')]);
  assert.equal(noKey.status,104,`restore without a key did not refuse cleanly: ${noKey.stdout}${noKey.stderr}`);
  assert.match(noKey.stderr,/Nothing has been changed/);
  const wrongKey=sh(['-c',[restoreLib,`OPENPPWR_BACKUP_PRIVATE_KEY=${shellPath(foreignKey)}`,`restore ${shellPath(backupSet)}`].join('; ')]);
  assert.equal(wrongKey.status,105,`restore with the wrong key did not refuse cleanly: ${wrongKey.stdout}${wrongKey.stderr}`);
  assert.match(wrongKey.stderr,/Nothing has been changed/);
  assert.ok(!existsSync(join(backupKeyRoot,'restore-attempt.log')),
    'a refused restore had already started stopping or backing up the deployment');
}finally{
  await rm(backupKeyRoot,{recursive:true,force:true});
  await rm(keyStore,{recursive:true,force:true});
}

console.log('INSTALLER_BACKUP_ENCRYPTION_PASS key_outside_root=enforced unconfigured_backup=refused ciphertext_opaque=true wrong_key_restore=refused_before_any_change');

// The journald retention drop-in, checked by generating the exact bytes the installer would write —
// the same reason write_env_file is exercised above rather than described. This is the only setting in
// the whole stack that expresses an AGE: Docker's json-file driver evicts by size and has no age option,
// so before this file existed the deployment's "retention" was a volume ceiling that kept a quiet month
// in full and discarded a busy day's predecessor.
//
// Generated without root, without systemd and without a host, so the shape of the promise is checked on
// every platform. Whether journald actually accepts it is a question only a Debian 13 host can answer,
// and `journal-retention apply` answers it there by re-reading what systemd resolved.
{
  const lib=['OPENPPWR_INSTALLER_LIB=1',`. ${shellPath(installer)}`].join('; ');
  const generated=sh(['-c',`${lib}; journal_retention_body`]);
  assert.equal(generated.status,0,generated.stderr);
  const body=generated.stdout;

  // Every key that has to be present, and why each one is not optional.
  const required=[
    // The age bound. Nothing else in the stack has one.
    ['MaxRetentionSec=30day','the retention period itself'],
    // Debian's default is Storage=auto, which means "persistent only if /var/log/journal exists" — and
    // Debian 13 creates that directory in the systemd postinst only on a NEW install. A host upgraded
    // into 13 logs to /run and keeps nothing across a reboot, so `auto` would make the period a fiction
    // on exactly the hosts nobody would think to check.
    ['Storage=persistent','persistence across a reboot'],
    // journald bounds by size whether or not anyone names a size: 10% of the filesystem capped at 4 GB.
    // Naming it is what makes the promise a stated number instead of a per-host accident.
    ['SystemMaxUse=1G','the size bound that shares the decision with the age bound'],
    // Deletion works on whole ARCHIVED files and never the active one, so an entry outlives the period by
    // up to one file. journald's default MaxFileSec is 1month, which under a 30day policy would let an
    // entry survive nearly two months.
    ['MaxFileSec=1day','the bound on how far an entry can outlive the retention period'],
  ];
  for(const [line,why] of required){
    assert.ok(new RegExp(`^${line.replace('.','\\.')}$`,'mu').test(body),
      `the journald drop-in does not set ${line} (${why})`);
  }

  // The file must say what it actually promises. A drop-in that reads "MaxRetentionSec=30day" and nothing
  // else invites the reader to quote "30 days", which is the one thing this configuration cannot
  // guarantee: the size bound and the age bound are applied together and the tighter one wins.
  assert.match(body,/whichever comes first/u,
    'the generated drop-in does not state that its promise is bounded by size as well as by age');
  assert.match(body,/^# Written by openppwr-installer\./mu,
    'the drop-in carries no ownership marker, so the installer cannot tell its own file from an operator\'s and would overwrite one silently');

  // Operator-settable, and the generated bytes must actually follow the variable rather than the default.
  const overridden=sh(['-c',`OPENPPWR_JOURNAL_RETENTION=7day OPENPPWR_JOURNAL_MAX_USE=256M ${lib}; journal_retention_body`]);
  assert.equal(overridden.status,0,overridden.stderr);
  assert.match(overridden.stdout,/^MaxRetentionSec=7day$/mu,'OPENPPWR_JOURNAL_RETENTION is ignored');
  assert.match(overridden.stdout,/^SystemMaxUse=256M$/mu,'OPENPPWR_JOURNAL_MAX_USE is ignored');
  assert.match(overridden.stdout,/"7day OR 256M, whichever comes first"/u,
    'the drop-in states a promise that does not match the values it was generated with');
}

console.log('INSTALLER_JOURNAL_RETENTION_PASS keys=MaxRetentionSec,Storage,SystemMaxUse,MaxFileSec promise=stated_as_age_or_size operator_overridable=true');

console.log(`INSTALLER_VALIDATION_PASS commands=${requiredCommands.length} shell_syntax=pass checksum_positive=pass checksum_negative=pass platform=${process.platform}`);
