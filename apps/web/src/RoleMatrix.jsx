// The role and capability matrix, rendered from the server's own permission registry.
//
// A matrix maintained as page copy is a second source of truth that drifts from the code silently.
// This fetches `/v1/permissions`, which returns the object `isAllowed` consults, so the page cannot
// claim a capability the server does not grant. `scripts/validation/permission-matrix-gate.mjs`
// fails the build if a permission exists in the registry that this file has no label for, which is
// what stops the drift running the other way.

import { Fragment, useEffect, useState } from 'react';
import { translate } from './i18n.js';
import { CAPABILITY_GROUPS, DISPLAY_ROLES } from './permission-matrix.js';

const labels = {
  en: {
    heading: 'Roles and permissions',
    intro: 'Read from the running deployment, not from this page. Every cell below reflects what the server grants; the interface hides actions a role cannot perform, but the server refuses them regardless.',
    capability: 'Capability', granted: 'granted', notGranted: 'not granted',
    source: 'Source: /v1/permissions on this deployment',
    unavailable: 'The permission registry could not be read from this deployment.',
    groups: { catalogue: 'Packaging, materials and BOM', evidence: 'Supplier evidence', assessment: 'Assessment and gaps', review: 'Review and dossier', audit: 'Audit', operations: 'Scanning operations', internal: 'Internal processing' },
    permissions: {
      read: 'View tenant records', 'read-own': 'View own supplier records only',
      'packaging:write': 'Import and edit packaging, materials and BOM',
      'evidence:upload': 'Upload evidence', 'evidence:review': 'Accept or reject evidence',
      'evidence:download': 'Download any evidence', 'evidence:download-own': 'Download own evidence',
      'assessment:run': 'Run assessment', 'gap:manage': 'Assign, remediate and reassess gaps',
      'review:freeze': 'Freeze a review', 'dossier:generate': 'Generate dossier',
      'dossier:download': 'Download dossier', 'audit:verify': 'Verify the audit chain',
      'scan:requeue': 'Requeue a scan job that reached its terminal state',
      'credential:rotate': "Replace another identity's bearer credential",
      'scan:process': 'Process scan jobs',
    },
  },
  pl: {
    heading: 'Role i uprawnienia',
    intro: 'Odczytane z działającego wdrożenia, nie z tej strony. Każda komórka odzwierciedla to, co przyznaje serwer; interfejs ukrywa działania niedostępne dla roli, ale serwer odmawia ich niezależnie od tego.',
    capability: 'Uprawnienie', granted: 'przyznane', notGranted: 'nieprzyznane',
    source: 'Źródło: /v1/permissions tego wdrożenia',
    unavailable: 'Nie udało się odczytać rejestru uprawnień z tego wdrożenia.',
    groups: { catalogue: 'Opakowania, materiały i BOM', evidence: 'Dowody dostawców', assessment: 'Ocena i luki', review: 'Przegląd i dokumentacja', audit: 'Audyt', operations: 'Operacje skanowania', internal: 'Przetwarzanie wewnętrzne' },
    permissions: {
      read: 'Podgląd rekordów tenanta', 'read-own': 'Podgląd wyłącznie własnych rekordów dostawcy',
      'packaging:write': 'Import i edycja opakowań, materiałów i BOM',
      'evidence:upload': 'Wgrywanie dowodów', 'evidence:review': 'Akceptacja lub odrzucenie dowodów',
      'evidence:download': 'Pobieranie dowolnych dowodów', 'evidence:download-own': 'Pobieranie własnych dowodów',
      'assessment:run': 'Uruchomienie oceny', 'gap:manage': 'Przypisywanie, naprawa i ponowna ocena luk',
      'review:freeze': 'Zamrożenie przeglądu', 'dossier:generate': 'Wygenerowanie dokumentacji',
      'dossier:download': 'Pobranie dokumentacji', 'audit:verify': 'Weryfikacja łańcucha audytu',
      'scan:requeue': 'Ponowne zakolejkowanie zadania skanowania w stanie końcowym',
      'credential:rotate': 'Wymiana poświadczenia innej tożsamości',
      'scan:process': 'Obsługa zadań skanowania',
    },
  },
  de: {
    heading: 'Rollen und Berechtigungen',
    intro: 'Aus dem laufenden Deployment gelesen, nicht aus dieser Seite. Jede Zelle zeigt, was der Server gewährt; die Oberfläche blendet Aktionen aus, die eine Rolle nicht ausführen kann, der Server verweigert sie ohnehin.',
    capability: 'Berechtigung', granted: 'gewährt', notGranted: 'nicht gewährt',
    source: 'Quelle: /v1/permissions dieses Deployments',
    unavailable: 'Die Berechtigungsregistrierung konnte nicht gelesen werden.',
    groups: { catalogue: 'Verpackungen, Materialien und Stückliste', evidence: 'Lieferantennachweise', assessment: 'Bewertung und Lücken', review: 'Prüfung und Dossier', audit: 'Audit', operations: 'Scan-Betrieb', internal: 'Interne Verarbeitung' },
    permissions: {
      read: 'Mandantendatensätze ansehen', 'read-own': 'Nur eigene Lieferantendatensätze ansehen',
      'packaging:write': 'Verpackungen, Materialien und Stückliste importieren und bearbeiten',
      'evidence:upload': 'Nachweise hochladen', 'evidence:review': 'Nachweise annehmen oder ablehnen',
      'evidence:download': 'Beliebige Nachweise herunterladen', 'evidence:download-own': 'Eigene Nachweise herunterladen',
      'assessment:run': 'Bewertung ausführen', 'gap:manage': 'Lücken zuweisen, beheben und neu bewerten',
      'review:freeze': 'Prüfung einfrieren', 'dossier:generate': 'Dossier erzeugen',
      'dossier:download': 'Dossier herunterladen', 'audit:verify': 'Audit-Kette verifizieren',
      'scan:requeue': 'Einen Scan-Job im Endzustand erneut einreihen',
      'credential:rotate': 'Anmeldedaten einer anderen Identität ersetzen',
      'scan:process': 'Scan-Jobs verarbeiten',
    },
  },
};

// The same label this matrix renders, for anything else that has to name a permission to a user.
//
// The workbench tells a user whose role lacks a permission which permission it is, and it must say
// "Generate dossier" rather than `dossier:generate`: a raw registry identifier would be the only
// untranslated string on a Polish or German screen. A second label table would be a second thing to
// keep in step with the registry, and `permission-matrix-gate.mjs` polices exactly one — this one.
//
// Naming a permission discloses nothing: `/v1/permissions` is unauthenticated, and the table below
// renders the whole registry to a reader who has not signed in at all.
export function permissionLabel(locale, permission) {
  const text = labels[locale] || labels.en;
  return text.permissions[permission] || labels.en.permissions[permission] || permission;
}

export function usePermissionRegistry() {
  const [registry, setRegistry] = useState(null);
  useEffect(() => {
    let active = true;
    fetch('/v1/permissions').then(async (response) => {
      const text = await response.text();
      if (!response.ok) return null;
      try { return JSON.parse(text); } catch { return null; }
    }).then((body) => { if (active && body?.roles?.length) setRegistry(body); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return registry;
}

export function RoleMatrix({ locale, compact = false }) {
  const registry = usePermissionRegistry();
  const text = labels[locale] || labels.en;
  const t = (key) => translate(locale, key);
  if (!registry) return <section className="role-matrix" data-testid="role-matrix">
    <h2>{text.heading}</h2><p>{text.unavailable}</p>
  </section>;
  const held = new Map(registry.roles.map((entry) => [entry.role, new Set(entry.permissions)]));
  const roles = DISPLAY_ROLES.filter((role) => held.has(role));
  // Every cell is now a plain membership test. There is no wildcard to expand and no administrator
  // special case: the server sends `tenant_admin` its explicit list like every other role.
  const grants = (role, permission) => held.get(role)?.has(permission) || false;
  return <section className="role-matrix" data-testid="role-matrix">
    <h2>{text.heading}</h2>
    <p>{text.intro}</p>
    <div className="table-wrap">
      <table>
        <thead><tr>
          <th scope="col">{text.capability}</th>
          {roles.map((role) => <th key={role} scope="col">{t(`role_${role}`)}</th>)}
        </tr></thead>
        <tbody>
          {CAPABILITY_GROUPS.filter((group) => !compact || group.key !== 'internal').map((group) => <Fragment key={group.key}>
            <tr className="matrix-group">
              <th scope="rowgroup" colSpan={roles.length + 1}>{text.groups[group.key]}</th>
            </tr>
            {group.permissions.map((permission) => <tr key={permission}>
              <th scope="row">{text.permissions[permission] || permission}</th>
              {roles.map((role) => {
                const on = grants(role, permission);
                return <td key={role} data-granted={on ? 'yes' : 'no'}>
                  <span aria-hidden="true">{on ? '●' : '—'}</span>
                  <span className="visually-hidden">{on ? text.granted : text.notGranted}</span>
                </td>;
              })}
            </tr>)}
          </Fragment>)}
        </tbody>
      </table>
    </div>
    <p className="matrix-source"><small>{text.source}</small></p>
  </section>;
}
