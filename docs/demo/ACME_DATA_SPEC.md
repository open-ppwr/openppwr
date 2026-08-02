# ACME Synthetic Data Specification

Status: APPROVED FOR ENGINEERING — synthetic specification, fixtures not yet generated

> All companies, products, materials, suppliers and documents in this environment are fictional and generated exclusively for demonstration and testing.

## Organizations

- ACME Packaging Europe GmbH
- ACME Manufacturing Polska Sp. z o.o.
- ACME Components s.r.o.
- ACME Distribution France SAS

## Suppliers

- Example Polymers GmbH
- Sample Foams Sp. z o.o.
- Demo Textiles AG
- Northwind Packaging Components B.V.

## Dataset shape

- 32 packaging records: 12 sales, 6 grouped, 6 transport, 4 e-commerce, 4 reusable.
- 18 materials across paper/fibre, glass, aluminium, steel, PET, PE, PP, wood, textile and composite families.
- 40 components and 32 versioned BOMs.
- Four suppliers with distinct evidence completeness profiles.
- CSV and JSON imports: 28 valid rows and 8 invalid rows covering missing identifiers, duplicate key, negative mass, invalid unit, unknown material, invalid packaging type, broken BOM reference and unsupported schema version.

## Stable identifiers

- Tenant: `ACME-EU-DEMO`
- Packaging: `ACME-PKG-001` through `ACME-PKG-032`
- Materials: `ACME-MAT-001` through `ACME-MAT-018`
- Components: `ACME-CMP-001` through `ACME-CMP-040`
- Suppliers: `ACME-SUP-001` through `ACME-SUP-004`
- Evidence: `ACME-EVD-001` onward

Identifiers are newly generated and carry no mapping to any real SKU, material, plant, SAP system or vendor.

## Evidence scenarios

- Supplier 001: complete, clean, accepted evidence.
- Supplier 002: missing recycled-content evidence.
- Supplier 003: expired declaration plus replacement evidence.
- Supplier 004: rejected MIME-mismatched upload followed by clean resubmission.
- One missing evidence item creates a gap, is assigned, uploaded, approved and closes after reassessment.

## Assessment outcomes

- `PASS`: all required inputs/evidence satisfy demonstration rule.
- `FAIL`: known material threshold failure.
- `UNKNOWN`: required evidence or input missing.
- `NOT_APPLICABLE`: rule scope/effective date excludes packaging.

Every result must reference rule ID/version, input snapshot, evidence IDs, explanation key, evaluation time and reviewer status.

## Dossiers

Generate PL, EN and DE variants containing product/BOM, suppliers, evidence manifest, assessment, gaps/remediation, audit verification and SHA-256 manifest. German regulatory wording remains `REQUIRES HUMAN DE REGULATORY REVIEW` until approved.
