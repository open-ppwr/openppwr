// SPDX-License-Identifier: Apache-2.0
//
// Structural validation of the release workflow's control flow.
//
// The supply-chain validator asserts on the workflow's *text*, and that has a demonstrated limit:
// replacing the release-evidence parity gate's condition with `if false` left the
// failure message and the `exit 1` in place, so the regex still matched and the check still reported
// PASS while the gate was disabled. Six control-flow guards could be removed the same way -- a
// condition, a `needs` list and a step-level `if:` are not text, and a regex cannot evaluate them.
//
// So this parses the workflow and asserts on the graph: which jobs exist, what each depends on, what
// conditions gate them, which permissions they hold, and where evidence may be produced. A regex
// proves a construct is present; this proves what it does.
//
// It deliberately does not emulate GitHub Actions. It validates one explicit security contract, and
// anything it does not recognise fails closed rather than passing by omission.

import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

export const WORKFLOW_PATH = '.github/workflows/release-image.yml';

export const RELEASE_CONTRACT = {
  jobs: {
    'validate-inputs': {
      needs: [],
      if: null,
      permissions: { contents: 'read' },
      environment: null,
    },
    'build-scan-publish-ghcr': {
      needs: ['validate-inputs'],
      if: null,
      permissions: {
        contents: 'read',
        packages: 'write',
        'id-token': 'write',
        attestations: 'write',
        'artifact-metadata': 'write',
      },
      environment: 'public-release',
    },
    'mirror-dockerhub': {
      needs: ['validate-inputs', 'build-scan-publish-ghcr'],
      if: 'inputs.publish',
      permissions: { contents: 'read', packages: 'read' },
      environment: null,
    },
    'release-evidence': {
      needs: ['build-scan-publish-ghcr', 'mirror-dockerhub'],
      if: 'inputs.publish',
      permissions: { contents: 'read' },
      environment: null,
    },
  },
  // The mirror publishes; nothing downstream of it may hold a scope that would let a compromised step
  // re-publish, re-attest or rewrite the repository.
  forbiddenScopesAfterBuild: ['packages', 'id-token', 'attestations', 'security-events', 'pull-requests'],
  // Evidence is a claim about what was published. The step that writes the success claim must not be
  // reachable when the steps that prove it did not run.
  successEvidenceSteps: ['Record mirror evidence', 'Assemble release evidence'],
  failureEvidenceSteps: ['Record mirror failure state', 'Upload mirror failure evidence'],
  // Guards that live inside `run:` blocks. The structural model cannot reach shell, so each is pinned
  // to one approved spelling and anything else fails closed. Chosen over a looser pattern because a
  // guard that can be reworded can be reworded into nothing.
  shellGuards: [
    {
      job: 'mirror-dockerhub',
      step: 'Read the canonical GHCR manifest',
      line: 'if [[ "$source_digest" != "$GHCR_DIGEST" ]]; then',
      purpose: 'the canonical image must not have moved between publication and copy',
    },
    {
      job: 'mirror-dockerhub',
      step: 'Validate mirror inputs',
      line: 'for forbidden in latest edge nightly stable; do',
      purpose: 'the mirror must refuse to publish a moving tag',
    },
    {
      job: 'validate-inputs',
      step: 'Verify publication prerequisites',
      line: 'for forbidden in latest edge nightly stable main master; do',
      purpose: 'the release must refuse a moving tag before anything is built',
    },
    {
      job: 'mirror-dockerhub',
      step: 'Prove the destination is the canonical image',
      line: 'if [[ "$dest_digest" != "$GHCR_DIGEST" ]]; then',
      purpose: 'digest parity between the registries is the whole point of the mirror',
    },
    {
      job: 'mirror-dockerhub',
      step: 'Copy the GHCR manifest to Docker Hub, or resume a matching copy',
      line: 'if [[ "$existing_digest" != "$GHCR_DIGEST" ]]; then',
      purpose: 'an existing tag holding a different image is a collision, never an overwrite',
    },
  ],
  // The one shell condition that decides whether a release is recorded as successful. Compared as an
  // exact approved form after whitespace normalisation: any other spelling, including a rearrangement
  // that happens to be equivalent, fails closed and must be re-approved deliberately.
  approvedParityGate: 'if [[ "$DIGEST_PARITY" != "PASS" || "$PLATFORM_PARITY" != "PASS" ]]; then',
  requiredVariables: ['PUBLICATION_REGISTRY_MODE', 'GHCR_IMAGE', 'DOCKERHUB_IMAGE', 'DOCKERHUB_USERNAME'],
  allowedSecrets: ['DOCKERHUB_TOKEN'],
};

const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
const asArray = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const normalise = (text) => text.replace(/\s+/gu, ' ').trim();

export function parseWorkflow(text) {
  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  const errors = document.errors.map((error) => error.message);
  if (errors.length) return { document: null, errors };
  return { document: document.toJS(), errors: [] };
}

function collectSteps(job) {
  return asArray(job?.steps).filter((step) => step && typeof step === 'object');
}

export function validateReleaseWorkflow(workflow, rawText = '') {
  const failures = [];
  const fail = (message) => failures.push(message);

  // A job that runs a file out of this repository must check the repository out.
  //
  // `mirror-dockerhub` did not, and called three subcommands of a helper script. It authenticated to GHCR
  // and to Docker Hub, then died with exit 127 at the first call, because the path did not exist on the
  // runner. Logging in to a registry and *then* discovering a missing file is the worst order for that to
  // happen in, and fifteen assertions already covering that job had all asked what it does rather than
  // whether it can reach what it runs.
  for (const [name, job] of Object.entries(workflow?.jobs || {})) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const runsRepoFile = steps.some((step) => typeof step?.run === 'string' && /(^|[\s"'`(])(?:\.\/)?scripts\//u.test(step.run));
    if (!runsRepoFile) continue;
    const checksOut = steps.some((step) => typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@'));
    if (!checksOut) fail(`job ${name} runs a file from scripts/ but never checks the repository out`);
  }

  if (!workflow || typeof workflow !== 'object') {
    return ['workflow did not parse into an object'];
  }

  // `on` is YAML 1.1 truthy, so a permissive loader hands it back under the boolean key.
  const triggers = workflow.on ?? workflow[true];
  if (!triggers || typeof triggers !== 'object') fail('workflow triggers are missing or not a mapping');
  else {
    const names = Object.keys(triggers);
    if (!sameSet(names, ['workflow_dispatch'])) {
      fail(`release must be manually dispatched only; found triggers: ${names.join(', ') || '<none>'}`);
    }
    const publish = triggers.workflow_dispatch?.inputs?.publish;
    if (!publish) fail('workflow_dispatch must expose a publish input');
    else {
      if (publish.type !== 'boolean') fail('publish input must be a boolean');
      if (publish.required !== true) fail('publish input must be required');
      if (publish.default !== false) fail('publish input must default to false');
    }
  }

  const topLevelPermissions = workflow.permissions;
  if (topLevelPermissions === undefined || (typeof topLevelPermissions === 'object' && topLevelPermissions !== null && Object.keys(topLevelPermissions).length !== 0)) {
    fail('top-level permissions must be an empty mapping so every scope is granted per job');
  }

  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== 'object') return [...failures, 'workflow declares no jobs'];

  const expectedJobs = Object.keys(RELEASE_CONTRACT.jobs);
  for (const name of expectedJobs) {
    if (!jobs[name]) fail(`required job is missing: ${name}`);
  }
  for (const name of Object.keys(jobs)) {
    if (!expectedJobs.includes(name)) fail(`unexpected job present: ${name}`);
  }

  for (const [name, expected] of Object.entries(RELEASE_CONTRACT.jobs)) {
    const job = jobs[name];
    if (!job) continue;

    const needs = asArray(job.needs);
    if (!sameSet(needs, expected.needs)) {
      fail(`job ${name} must declare needs [${expected.needs.join(', ') || '<none>'}]; found [${needs.join(', ') || '<none>'}]`);
    }

    const condition = job.if === undefined ? null : String(job.if).trim();
    if (condition !== expected.if) {
      fail(`job ${name} condition must be ${expected.if === null ? '<absent>' : `'${expected.if}'`}; found ${condition === null ? '<absent>' : `'${condition}'`}`);
    }
    // Named explicitly rather than left to the comparison above, because these are the bypasses a
    // future edit would reach for and the diagnosis should say so.
    if (condition && /^(true|false)$/iu.test(condition)) fail(`job ${name} condition is a constant: '${condition}'`);
    if (condition && /always\s*\(\s*\)/u.test(condition)) fail(`job ${name} uses always(), which runs it after a failed dependency`);

    const environment = job.environment === undefined ? null : job.environment;
    if (environment !== expected.environment) {
      fail(`job ${name} environment must be ${expected.environment ?? '<absent>'}; found ${environment ?? '<absent>'}`);
    }

    const permissions = job.permissions ?? {};
    const expectedPermissions = expected.permissions;
    if (!sameSet(Object.keys(permissions), Object.keys(expectedPermissions))) {
      fail(`job ${name} permissions must be exactly [${Object.keys(expectedPermissions).join(', ')}]; found [${Object.keys(permissions).join(', ') || '<none>'}]`);
    } else {
      for (const [scope, level] of Object.entries(expectedPermissions)) {
        if (permissions[scope] !== level) fail(`job ${name} permission ${scope} must be '${level}'; found '${permissions[scope]}'`);
      }
    }

    if (job['continue-on-error'] !== undefined) fail(`job ${name} must not set continue-on-error`);
    for (const step of collectSteps(job)) {
      if (step['continue-on-error'] !== undefined) {
        fail(`step '${step.name ?? step.uses ?? '<unnamed>'}' in ${name} must not set continue-on-error`);
      }
    }
  }

  // Jobs after the build must not hold a scope that could publish or attest on their own.
  for (const name of ['mirror-dockerhub', 'release-evidence']) {
    const permissions = jobs[name]?.permissions ?? {};
    for (const [scope, level] of Object.entries(permissions)) {
      if (RELEASE_CONTRACT.forbiddenScopesAfterBuild.includes(scope) && level === 'write') {
        fail(`job ${name} must not hold ${scope}: write`);
      }
      if (scope === 'contents' && level === 'write') fail(`job ${name} must not hold contents: write`);
    }
  }

  // Evidence ordering. The success claim must be unconditional inside a job that already depends on
  // the jobs that prove it; a condition here is how "evidence only after success" quietly becomes
  // "evidence regardless".
  const allSteps = Object.entries(jobs).flatMap(([jobName, job]) => collectSteps(job).map((step) => ({ jobName, step })));
  for (const stepName of RELEASE_CONTRACT.successEvidenceSteps) {
    const found = allSteps.find(({ step }) => step.name === stepName);
    if (!found) fail(`required evidence step is missing: ${stepName}`);
    else if (found.step.if !== undefined) {
      fail(`success evidence step '${stepName}' must carry no condition; found '${found.step.if}'`);
    }
  }
  for (const stepName of RELEASE_CONTRACT.failureEvidenceSteps) {
    const found = allSteps.find(({ step }) => step.name === stepName);
    if (!found) fail(`required failure-evidence step is missing: ${stepName}`);
    else if (normalise(String(found.step.if ?? '')) !== 'failure()') {
      fail(`failure evidence step '${stepName}' must run on failure(); found '${found.step.if ?? '<absent>'}'`);
    }
  }

  // The release summary must be assembled from the mirror's own outputs, so a mirror that did not run
  // cannot leave a successful record behind.
  const evidenceJob = jobs['release-evidence'];
  const evidenceText = JSON.stringify(evidenceJob ?? {});
  for (const output of ['digest_parity', 'platform_parity', 'dockerhub_digest']) {
    if (!evidenceText.includes(`needs.mirror-dockerhub.outputs.${output}`)) {
      fail(`release evidence must read needs.mirror-dockerhub.outputs.${output}`);
    }
  }

  // The parity gate is shell, not structure. Compared against one approved spelling: an unrecognised
  // variant is rejected rather than assumed equivalent.
  const gateSteps = collectSteps(evidenceJob).filter((step) => typeof step.run === 'string' && step.run.includes('RELEASE_EVIDENCE_FAIL'));
  if (gateSteps.length !== 1) fail('release evidence must contain exactly one parity gate');
  else {
    const conditions = [...gateSteps[0].run.matchAll(/^\s*(if\s+.*?;\s*then)\s*$/gmu)].map((match) => normalise(match[1]));
    if (!conditions.includes(normalise(RELEASE_CONTRACT.approvedParityGate))) {
      fail(`release evidence parity gate does not match the approved condition; found [${conditions.join(' | ') || '<none>'}]`);
    }
  }

  // Shell guards, located by job and step so a guard cannot be satisfied by the same text appearing
  // somewhere harmless, such as a comment or a diagnostic message.
  for (const guard of RELEASE_CONTRACT.shellGuards) {
    const step = collectSteps(jobs[guard.job]).find((candidate) => candidate.name === guard.step);
    if (!step) {
      fail(`required step is missing: ${guard.job} / ${guard.step}`);
      continue;
    }
    const lines = String(step.run ?? '').split('\n').map(normalise);
    if (!lines.includes(normalise(guard.line))) {
      fail(`guard removed or reworded in ${guard.job} / ${guard.step} (${guard.purpose}): expected '${guard.line}'`);
    }
  }

  // Text-level contract that the structural model cannot express.
  if (rawText) {
    const secrets = [...new Set([...rawText.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]))];
    for (const secret of secrets) {
      if (!RELEASE_CONTRACT.allowedSecrets.includes(secret)) fail(`unexpected secret reference: secrets.${secret}`);
    }
    for (const variable of RELEASE_CONTRACT.requiredVariables) {
      if (!rawText.includes(`vars.${variable}`)) fail(`required variable is not referenced: vars.${variable}`);
    }
    for (const [, reference] of rawText.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)) {
      if (!/@[a-f0-9]{40}$/u.test(reference)) fail(`action is not pinned to a full commit SHA: ${reference}`);
    }
    if ((rawText.match(/^\s*--prefer-index=false(\s|\\|$)/gmu) ?? []).length !== 1) {
      fail('--prefer-index=false must be passed exactly once, on the copy command');
    }
    if (/value=latest|openppwr:latest/u.test(rawText)) fail('a moving latest tag must not be published');
  }

  return failures;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop());
if (invokedDirectly) {
  const rawText = await readFile(WORKFLOW_PATH, 'utf8');
  const { document, errors } = parseWorkflow(rawText);
  const failures = errors.length ? errors : validateReleaseWorkflow(document, rawText);
  if (failures.length) {
    console.error(`RELEASE_WORKFLOW_STRUCTURE_FAIL findings=${failures.length}\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    const jobCount = Object.keys(document.jobs).length;
    console.log(`RELEASE_WORKFLOW_STRUCTURE_PASS jobs=${jobCount} contract=${Object.keys(RELEASE_CONTRACT.jobs).length}`);
  }
}
