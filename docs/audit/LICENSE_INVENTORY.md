# License inventory and review record

Status: release-candidate package implemented; final public distribution remains
subject to consolidated owner/legal approval.

## First-party material

Owner direction applies Apache License 2.0 to Attentus-owned OpenPPWR Community
source, public SDKs and integration contracts, public documentation, examples
and synthetic ACME assets prepared for release. `LICENSE`, `NOTICE`, package
SPDX metadata, DCO 1.1 and trademark/commercial-boundary policies implement that
direction for the release candidate.

This record does not establish ownership of third-party material. Clean-room
reuse authorization and final public package remain human legal-review gates.
Commercial products and trademarks remain outside the Apache-2.0 grant as
documented in `docs/architecture/OPEN_CORE_BOUNDARY.md` and `TRADEMARKS.md`.

## Third-party dependencies

`docs/audit/THIRD_PARTY_LICENSE_INVENTORY.md` is generated from exact
`package-lock.json` metadata. Run:

```powershell
node scripts/release/generate-third-party-inventory.mjs --check
```

Current reviewed expressions are MIT, ISC, Apache-2.0, BSD-3-Clause, 0BSD,
MIT/Zlib and the DejaVu font terms. Three lockfile omissions are resolved from
package-supplied license files: `busboy@1.6.0`, `png-js@1.1.0` and
`streamsearch@1.1.0`, all MIT. No incompatible expression was found in the
current lockfile. New or changed license expressions fail inventory generation
until reviewed.

`dejavu-fonts-ttf@2.37.3` supplies the embedded `DejaVuSans.ttf` used for
Unicode dossiers. Required Bitstream Vera and Arev notices are reproduced in
`THIRD_PARTY_NOTICES.md`. Installed third-party packages retain their upstream
license files and are not relicensed.

## Historical audit findings

Initial Phase 1 audit reported 46 undeclared lock entries and MPL-2.0 entries
because counts mixed workspace/link metadata with external packages. Current
normalization excludes first-party workspace links, deduplicates exact external
package versions, distinguishes production from development scope and resolves
all remaining external omissions from package-supplied evidence. Historical
finding remains recorded here; it was not silently rewritten as absent.

## Remaining legal gate

Before public distribution, human owner/legal review must confirm Attentus
ownership/authorization for every first-party release file, validate notices
against final release image contents, and approve exact release SHA/export.
