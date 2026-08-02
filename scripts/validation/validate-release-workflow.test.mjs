// SPDX-License-Identifier: Apache-2.0
//
// Mutation tests for the release workflow's control flow.
//
// Six control-flow guards were mutated and the text-based validator detected none of
// them: a condition, a `needs` list and a step-level `if:` are not text. Every mutation below is one
// of those survivors or a bypass of the same shape. Each mutates the real workflow, re-parses it, and
// asserts the structural validator rejects the result -- a check that cannot fail proves nothing, and
// that was the finding.
//
// Nothing here contacts a registry, runs a workflow or writes to the repository.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWorkflow, validateReleaseWorkflow, RELEASE_CONTRACT } from './validate-release-workflow.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawWorkflow = await readFile(resolve(repositoryRoot, '.github/workflows/release-image.yml'), 'utf8');

function validate(text) {
  const { document, errors } = parseWorkflow(text);
  if (errors.length) return errors;
  return validateReleaseWorkflow(document, text);
}

function mutate(text, from, to) {
  assert.ok(text.includes(from), `mutation anchor not found, the test would be vacuous: ${from.slice(0, 70)}`);
  return text.replace(from, to);
}

test('the workflow as committed satisfies the structural contract', () => {
  assert.deepEqual(validate(rawWorkflow), []);
});

// ---------------------------------------------------------------------------------------------
// The evidence job's dependency on the mirror
// ---------------------------------------------------------------------------------------------
test('removing the mirror from release-evidence needs is rejected', () => {
  const mutated = mutate(rawWorkflow, '    needs:\n      - build-scan-publish-ghcr\n      - mirror-dockerhub', '    needs:\n      - build-scan-publish-ghcr');
  assert.match(validate(mutated).join('\n'), /release-evidence must declare needs/u);
});

test('removing needs entirely from release-evidence is rejected', () => {
  const mutated = mutate(rawWorkflow, '    needs:\n      - build-scan-publish-ghcr\n      - mirror-dockerhub\n', '');
  assert.match(validate(mutated).join('\n'), /release-evidence must declare needs/u);
});

test('removing the build dependency from the mirror is rejected', () => {
  const mutated = mutate(rawWorkflow, '    needs:\n      - validate-inputs\n      - build-scan-publish-ghcr', '    needs:\n      - validate-inputs');
  assert.match(validate(mutated).join('\n'), /mirror-dockerhub must declare needs/u);
});

// ---------------------------------------------------------------------------------------------
// The parity gate condition
// ---------------------------------------------------------------------------------------------
test('neutralising the parity gate with if false is rejected', () => {
  const mutated = mutate(rawWorkflow, RELEASE_CONTRACT.approvedParityGate, 'if false; then');
  assert.match(validate(mutated).join('\n'), /parity gate does not match the approved condition/u);
});

test('neutralising the parity gate with if true is rejected', () => {
  const mutated = mutate(rawWorkflow, RELEASE_CONTRACT.approvedParityGate, 'if true; then');
  assert.match(validate(mutated).join('\n'), /parity gate does not match the approved condition/u);
});

test('dropping the platform half of the parity gate is rejected', () => {
  const mutated = mutate(rawWorkflow, RELEASE_CONTRACT.approvedParityGate, 'if [[ "$DIGEST_PARITY" != "PASS" ]]; then');
  assert.match(validate(mutated).join('\n'), /parity gate does not match the approved condition/u);
});

test('dropping the digest half of the parity gate is rejected', () => {
  const mutated = mutate(rawWorkflow, RELEASE_CONTRACT.approvedParityGate, 'if [[ "$PLATFORM_PARITY" != "PASS" ]]; then');
  assert.match(validate(mutated).join('\n'), /parity gate does not match the approved condition/u);
});

test('negating the parity gate is rejected', () => {
  const mutated = mutate(rawWorkflow, RELEASE_CONTRACT.approvedParityGate, 'if [[ "$DIGEST_PARITY" == "PASS" && "$PLATFORM_PARITY" == "PASS" ]]; then');
  assert.match(validate(mutated).join('\n'), /parity gate does not match the approved condition/u);
});

test('reading parity from a hardcoded value instead of the mirror output is rejected', () => {
  const mutated = mutate(rawWorkflow, 'DIGEST_PARITY: ${{ needs.mirror-dockerhub.outputs.digest_parity }}', 'DIGEST_PARITY: PASS');
  assert.match(validate(mutated).join('\n'), /must read needs\.mirror-dockerhub\.outputs\.digest_parity/u);
});

// ---------------------------------------------------------------------------------------------
// Evidence ordering
// ---------------------------------------------------------------------------------------------
for (const [label, condition] of [['always()', 'always()'], ['a constant', 'true'], ['failure()', 'failure()']]) {
  test(`making the mirror success evidence conditional on ${label} is rejected`, () => {
    const mutated = mutate(rawWorkflow, '      - name: Record mirror evidence\n        run: |', `      - name: Record mirror evidence\n        if: ${condition}\n        run: |`);
    assert.match(validate(mutated).join('\n'), /success evidence step 'Record mirror evidence' must carry no condition/u);
  });
}

test('making the release evidence conditional is rejected', () => {
  const mutated = mutate(rawWorkflow, '      - name: Assemble release evidence\n        env:', '      - name: Assemble release evidence\n        if: always()\n        env:');
  assert.match(validate(mutated).join('\n'), /success evidence step 'Assemble release evidence' must carry no condition/u);
});

test('removing the failure-evidence condition is rejected', () => {
  const mutated = mutate(rawWorkflow, '      - name: Record mirror failure state\n        if: failure()', '      - name: Record mirror failure state\n        if: always()');
  assert.match(validate(mutated).join('\n'), /must run on failure\(\)/u);
});

test('disabling the failure-evidence upload is rejected', () => {
  const mutated = mutate(rawWorkflow, '      - name: Upload mirror failure evidence\n        if: failure()', '      - name: Upload mirror failure evidence\n        if: false');
  assert.match(validate(mutated).join('\n'), /must run on failure\(\)/u);
});

// ---------------------------------------------------------------------------------------------
// Shell guards inside run blocks — the structural model cannot reach these, so each is pinned
// ---------------------------------------------------------------------------------------------
for (const guard of RELEASE_CONTRACT.shellGuards) {
  test(`neutralising the guard in ${guard.job} / ${guard.step} is rejected`, () => {
    const replacement = guard.line.startsWith('if ') ? 'if false; then' : 'for forbidden in ; do';
    const mutated = mutate(rawWorkflow, guard.line, replacement);
    assert.match(validate(mutated).join('\n'), /guard removed or reworded/u);
  });

  test(`removing the guard in ${guard.job} / ${guard.step} entirely is rejected`, () => {
    const mutated = mutate(rawWorkflow, guard.line, '');
    assert.match(validate(mutated).join('\n'), /guard removed or reworded/u);
  });
}

test('a guard satisfied only by a comment elsewhere is still rejected', () => {
  // The guard is located by job and step, so the same text in a diagnostic or comment cannot stand
  // in for the real check.
  const guard = RELEASE_CONTRACT.shellGuards[0];
  const mutated = mutate(rawWorkflow, guard.line, `echo "would check: ${guard.line}"`);
  assert.match(validate(mutated).join('\n'), /guard removed or reworded/u);
});

// ---------------------------------------------------------------------------------------------
// Job gating
// ---------------------------------------------------------------------------------------------
test('running the mirror unconditionally is rejected', () => {
  const mutated = mutate(rawWorkflow, '    if: inputs.publish\n    runs-on: ubuntu-latest\n    timeout-minutes: 20', '    if: always()\n    runs-on: ubuntu-latest\n    timeout-minutes: 20');
  const output = validate(mutated).join('\n');
  assert.match(output, /mirror-dockerhub condition must be/u);
  assert.match(output, /always\(\)/u);
});

test('removing the publish gate from the mirror is rejected', () => {
  const mutated = mutate(rawWorkflow, '    if: inputs.publish\n    runs-on: ubuntu-latest\n    timeout-minutes: 20', '    runs-on: ubuntu-latest\n    timeout-minutes: 20');
  assert.match(validate(mutated).join('\n'), /mirror-dockerhub condition must be 'inputs\.publish'/u);
});

// ---------------------------------------------------------------------------------------------
// continue-on-error
// ---------------------------------------------------------------------------------------------
test('continue-on-error on the mirror job is rejected', () => {
  const mutated = mutate(rawWorkflow, '    timeout-minutes: 20\n', '    timeout-minutes: 20\n    continue-on-error: true\n');
  assert.match(validate(mutated).join('\n'), /must not set continue-on-error/u);
});

test('continue-on-error on an individual step is rejected', () => {
  const mutated = mutate(rawWorkflow, '      - name: Record mirror evidence\n        run: |', '      - name: Record mirror evidence\n        continue-on-error: true\n        run: |');
  assert.match(validate(mutated).join('\n'), /must not set continue-on-error/u);
});

// ---------------------------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------------------------
for (const scope of ['packages: write', 'id-token: write', 'attestations: write', 'contents: write']) {
  test(`granting the mirror job ${scope} is rejected`, () => {
    const mutated = mutate(rawWorkflow, '    permissions:\n      contents: read\n      packages: read', `    permissions:\n      contents: read\n      ${scope}`);
    assert.notDeepEqual(validate(mutated), []);
  });
}

test('a non-empty top-level permissions block is rejected', () => {
  const mutated = mutate(rawWorkflow, 'permissions: {}', 'permissions:\n  contents: write');
  assert.match(validate(mutated).join('\n'), /top-level permissions must be an empty mapping/u);
});

// ---------------------------------------------------------------------------------------------
// Triggers, variables, secrets, pinning
// ---------------------------------------------------------------------------------------------
test('adding a push trigger is rejected', () => {
  const mutated = mutate(rawWorkflow, 'on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:');
  assert.match(validate(mutated).join('\n'), /manually dispatched only/u);
});

test('defaulting the publish input to true is rejected', () => {
  const mutated = mutate(rawWorkflow, '        default: false', '        default: true');
  assert.match(validate(mutated).join('\n'), /publish input must default to false/u);
});

test('referencing an unexpected secret is rejected', () => {
  const mutated = mutate(rawWorkflow, '${{ secrets.DOCKERHUB_TOKEN }}', '${{ secrets.SOME_OTHER_TOKEN }}');
  assert.match(validate(mutated).join('\n'), /unexpected secret reference/u);
});

test('removing a required variable reference is rejected', () => {
  const mutated = mutate(rawWorkflow, 'vars.PUBLICATION_REGISTRY_MODE', 'vars.SOMETHING_ELSE');
  assert.match(validate(mutated).join('\n'), /required variable is not referenced/u);
});

test('an unpinned action is rejected', () => {
  const mutated = mutate(rawWorkflow, 'uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'uses: actions/checkout@v4');
  assert.match(validate(mutated).join('\n'), /not pinned to a full commit SHA/u);
});

test('removing --prefer-index=false is rejected', () => {
  const mutated = mutate(rawWorkflow, '            --prefer-index=false \\\n', '');
  assert.match(validate(mutated).join('\n'), /--prefer-index=false must be passed exactly once/u);
});

test('publishing a moving latest tag is rejected', () => {
  const mutated = mutate(rawWorkflow, 'tags: type=raw,value=1.0.0', 'tags: type=raw,value=latest');
  assert.match(validate(mutated).join('\n'), /moving latest tag must not be published/u);
});

// ---------------------------------------------------------------------------------------------
// Structural integrity of the graph itself
// ---------------------------------------------------------------------------------------------
test('an unexpected extra job is rejected', () => {
  const mutated = `${rawWorkflow}\n  sneak-publish:\n    runs-on: ubuntu-latest\n    permissions:\n      packages: write\n    steps:\n      - run: echo hi\n`;
  assert.match(validate(mutated).join('\n'), /unexpected job present: sneak-publish/u);
});

test('duplicate YAML keys are rejected rather than silently overriding', () => {
  const mutated = mutate(rawWorkflow, '  mirror-dockerhub:\n', '  mirror-dockerhub:\n    permissions:\n      packages: write\n');
  assert.notDeepEqual(validate(mutated), []);
});

test('removing the protected environment from the build job is rejected', () => {
  const mutated = mutate(rawWorkflow, '    environment: public-release\n', '');
  assert.match(validate(mutated).join('\n'), /environment must be public-release/u);
});
