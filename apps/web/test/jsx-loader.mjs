// A module loader that lets `node --test` import the shipped `.jsx` components directly.
//
// The interface files are the ones that decide what a user is shown, and until now nothing under test
// could import them at all: Node has no JSX, so every claim about what the workbench renders had to be
// made against a source string or against a live browser. Both of those are how a destructive button
// that no user could press came to be rendered for every user.
//
// The transform is esbuild's, which is the same one Vite runs for the production bundle, so a component
// that renders here is the component that ships.
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const { code } = await transform(source, { loader: 'jsx', format: 'esm', jsx: 'automatic' });
  return { format: 'module', source: code, shortCircuit: true };
}
