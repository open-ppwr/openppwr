// SPDX-License-Identifier: Apache-2.0
//
// Which workspace packages no running service imports.
//
// This computation used to live inside `release-contract-gate.mjs`, and it is the reason that gate can
// state "three packages ship and are never reachable" without anybody maintaining the list: the answer is
// read out of the import graph rather than out of a sentence somebody wrote once.
//
// It lives here because a second consumer arrived. `product-docs-gate.mjs` checks the same claim where a
// self-hoster actually meets it — the shipped documentation portal — and the claim had in fact already
// rotted there: the portal named `supplier-evidence` as unreachable while `packages/dossier` imports it to
// build the dossier ZIP. Copying the traversal into the second gate would have produced two answers to one
// question, which is precisely the defect both gates exist to prevent, so there is one function and two
// callers.
//
// The traversal is deliberately textual. A workspace package counts as reachable when its declared name
// appears in the source of a running service, or in the source of another workspace package; resolving
// imports properly would be more precise and would also be a second module loader to keep correct. A
// false "reachable" produced by a name inside a comment is the safe direction: it makes the gates refuse
// a claim of unreachability, which is the claim that misleads a reader.

import { existsSync, readFileSync, readdirSync } from 'node:fs';

const RUNTIME_EXTENSIONS = /\.(?:mjs|js|jsx|cjs)$/u;

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (RUNTIME_EXTENSIONS.test(entry.name)) found.push(path);
  }
  return found;
}

// `{ directory, name }` for every workspace package under `packages/`, in directory order.
export function workspacePackages() {
  return readdirSync('packages').map((directory) => ({
    directory: `packages/${directory}`,
    name: JSON.parse(readFileSync(`packages/${directory}/package.json`, 'utf8')).name,
  }));
}

// The packages nothing in a running service imports.
//
// The entry points a container actually runs sit beside `src/` rather than inside it, so a scan of `src/`
// alone would call an app's own server file unreachable and, worse, miss the packages it imports.
export function unreachablePackages() {
  const runtimeDirectories = [
    ...readdirSync('apps').map((name) => `apps/${name}/src`),
    ...readdirSync('packages').map((name) => `packages/${name}/src`),
  ];
  const runtimeSources = [
    ...runtimeDirectories.flatMap(sourceFiles),
    ...readdirSync('apps').flatMap((name) => sourceFiles(`apps/${name}`).filter((path) => !path.includes('/test/'))),
  ];
  const importedNames = new Set();
  for (const file of new Set(runtimeSources)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/@openppwr\/[a-z-]+/gu)) importedNames.add(match[0]);
  }
  return workspacePackages().filter((entry) => !importedNames.has(entry.name));
}
