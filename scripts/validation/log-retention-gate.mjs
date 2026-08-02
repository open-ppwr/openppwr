// SPDX-License-Identifier: Apache-2.0
//
// Log retention gate.
//
// The register recorded log retention as "not enforced" for as long as it did because the deployment
// could not express the control at all: Docker's json-file driver evicts by size and has no age option,
// so nothing writable in a compose file discards a log for being thirty-one days old. A size cap is a
// promise about volume wearing a retention period's clothes — a quiet month is kept in full and a busy
// day discards the previous one.
//
// The fix moves every container's stream onto journald and puts the age bound in a host drop-in the
// installer writes. This gate asserts the half of that which is checkable without a host, and it exists
// because the regression is silent in both directions:
//
//   - a service whose `logging:` block is dropped falls back to the DAEMON default, which is json-file.
//     Nothing fails, nothing warns, and that service's logs quietly stop having an age bound.
//   - a service that keeps journald but loses its tag merges into another service's stream, and
//     `journalctl -t` can no longer answer "show me the API".
//
// It also refuses to let the shipped wording drift back to claiming a period. journald bounds by age AND
// by size and the tighter one wins, so "30 days" is not a statement this deployment can make; only
// "30 days or 1 GB, whichever comes first" is. That sentence is load-bearing and is asserted here.
//
//   node scripts/validation/log-retention-gate.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const composePath = fileURLToPath(new URL('../../deploy/community/docker-compose.yml', import.meta.url));
const installerPath = fileURLToPath(new URL('../installer/openppwr-installer', import.meta.url));
const envExamplePath = fileURLToPath(new URL('../../deploy/community/openppwr.env.example', import.meta.url));

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const composeSource = await readFile(composePath, 'utf8');
const installerSource = await readFile(installerPath, 'utf8');
const envExample = await readFile(envExamplePath, 'utf8');

// Parsed, not grepped. `<<: *app` means a service's effective logging block is not the one written beside
// its name, and a regex over the text cannot tell an inherited driver from a declared one — which is
// precisely the case that has to be right. `merge: true` resolves the anchor the way Compose does.
const compose = parse(composeSource, { merge: true });
const services = compose.services ?? {};
const names = Object.keys(services);

check(names.length >= 6, `expected the full shipped service list, found ${names.length}: ${names.join(', ')}`);

const tags = new Map();
for (const [name, service] of Object.entries(services)) {
  const logging = service?.logging;
  check(logging !== undefined, `service ${name} declares no logging block, so it inherits Docker's daemon default (json-file) and has no age bound`);
  if (!logging) continue;

  check(logging.driver === 'journald',
    `service ${name} logs with driver "${logging.driver}", which cannot express a retention period; only journald can`);

  const tag = logging.options?.tag;
  check(typeof tag === 'string' && tag.length > 0,
    `service ${name} sets no journald tag, so its stream cannot be selected with journalctl -t and merges into another service's`);
  if (typeof tag !== 'string') continue;

  // Two independent stacks on one host share a single journal. A tag of "api" alone would interleave
  // them, and the compose project name is the only thing that distinguishes them.
  check(tag.includes('OPENPPWR_COMPOSE_PROJECT'),
    `service ${name} has the fixed tag "${tag}"; without the compose project name a second stack on the same host merges into this one's journal stream`);

  // The tag must NAME this service, not merely differ from the others. Four services take `<<: *app`, and
  // a service that loses its own logging block inherits the anchor's generic tag instead — leaving the
  // driver correct, every tag still distinct, and that service's stream silently merged into the
  // fallback. Checked by deleting api's block: the gate passed, which is the whole failure it exists to
  // catch. Distinctness is not the property; being selectable AS THIS SERVICE is.
  check(tag.endsWith(`.${name}`),
    `service ${name} carries the tag "${tag}", which does not end in ".${name}"; it has inherited the anchor's fallback rather than naming itself, so journalctl -t cannot select this service`);

  check(!tags.has(tag), `services ${tags.get(tag)} and ${name} share the journald tag "${tag}", so neither can be selected alone`);
  tags.set(tag, name);
}

// The directive, not the prose. The comments in these files necessarily discuss json-file — explaining
// why it was abandoned is the point — so this looks for the setting rather than the string.
for (const [label, source] of [['docker-compose.yml', composeSource], ['openppwr.env.example', envExample]]) {
  const directives = [...source.matchAll(/^\s*driver:\s*(\S+)/gmu)].map((match) => match[1]);
  const offending = directives.filter((driver) => driver !== 'journald');
  check(offending.length === 0, `${label} names log driver(s) ${offending.join(', ')}; only journald can express an age bound`);
}

// The retired variables must not come back as live settings. They were a volume ceiling described as
// retention, and a deployment that still honoured them would have two competing answers to the same
// question. A comment saying they are gone is expected and required; an interpolation is not.
for (const retired of ['OPENPPWR_LOG_MAX_SIZE', 'OPENPPWR_LOG_MAX_FILE']) {
  check(!new RegExp(`\\$\\{${retired}`, 'u').test(composeSource),
    `docker-compose.yml still interpolates ${retired}, a size cap that was never a retention period`);
  check(envExample.includes(retired),
    `openppwr.env.example no longer mentions ${retired}; an operator who set it deserves to be told it now does nothing rather than left to assume it still works`);
}

// The installer half. The drop-in is where the age actually lives, so the compose file being right buys
// nothing if the installer stopped writing it.
// Matched against the DIRECTIVES the installer emits, never against its prose. Both files necessarily
// explain json-file, Storage=auto and the rest at length, and a check satisfied by the paragraph
// describing a setting rather than by the setting itself cannot fail — the same defect this gate caught
// in its own tag check a few lines above.
check(/^JOURNAL_DROPIN_DIR=\/etc\/systemd\/journald\.conf\.d$/mu.test(installerSource),
  'the installer no longer writes a journald drop-in, so no retention period is applied to the host at all');
check(/MaxRetentionSec=%s/u.test(installerSource),
  'the installer drop-in no longer sets MaxRetentionSec, which is the only setting in the stack that expresses an age');
check(/printf 'Storage=persistent/u.test(installerSource),
  'the installer drop-in no longer emits Storage=persistent; on a host whose /var/log/journal does not exist journald defaults to volatile and keeps nothing across a reboot');
check(installerSource.includes('journal_verify'),
  'the installer no longer verifies the applied journald configuration; a value journald silently ignored would report success');
check(installerSource.includes('journal_conflicts'),
  "the installer no longer detects an operator's own journald configuration and would overwrite it silently");
check(/journal-retention\) journal_retention/u.test(installerSource),
  'journal-retention is not reachable as a command, so an operator cannot inspect or re-apply the retention setting');

// The wording. This is the assertion that keeps the documentation honest when someone rounds
// "30 days or 1 GB, whichever comes first" down to "30 days" because it reads better.
check(/whichever comes first/iu.test(envExample),
  'openppwr.env.example no longer states that the retention promise is bounded by size as well as age; "30 days" alone is a claim this deployment cannot keep');
check(/whichever[- ]first|whichever comes first/iu.test(installerSource),
  'the installer no longer states the combined age-and-size promise where an operator reading the generated file would see it');

if (failures.length > 0) {
  console.error('LOG_RETENTION_GATE_FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const summary = [...tags.keys()].map((tag) => tag.replace(/\$\{OPENPPWR_COMPOSE_PROJECT:-openppwr-community\}/u, '<project>')).sort();
console.log(`LOG_RETENTION_GATE_PASS services=${names.length} driver=journald tags=${summary.length} distinct=${summary.join(',')}`);
