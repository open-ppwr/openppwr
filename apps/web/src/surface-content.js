// Copy for the surfaces that are not the marketing site: the demonstration entry point, the status
// page and the Community landing.
//
// These existed as hostnames with nothing behind them. Every one of them rendered the marketing
// homepage, so a reader who followed a link to the demonstration arrived at a product pitch and a
// reader checking the status of the service was told what the product is for.
//
// One rule governs everything in this file, because the file ships to operators we will never meet:
//
//   A string here may state facts about the *software* — what it does, what it is licensed under,
//   what an edition contains. It may not state facts about a *deployment* — who hosts it, who is
//   allowed to reach it, what sits in front of it, what its incident history is, or whether some
//   repository has been published — because this bundle renders on every installation and those
//   facts are different on each one.
//
// Where a deployment fact genuinely has to be shown, it is read from the running build through
// `/v1/version` and rendered as the build stamp, so the page and its source of truth are the same
// value and cannot drift apart. Where it cannot be read, nothing is claimed.
//
// This is enforced: `scripts/validation/copy-style-gate.mjs` fails on provider names, edge-access
// names, and release-state claims in this file unless the sentence names the deployment it is
// describing.

export const SURFACE_LOCALES = ['pl', 'en', 'de'];

export const surfaceCommon = {
  en: {
    demoLabel: 'Demonstration', statusLabel: 'Service status', communityLabel: 'Community',
    docsLabel: 'Documentation', productSite: 'Product website', workbench: 'Workbench',
    language: 'Language', backToProduct: 'OpenPPWR product website', siteNav: 'OpenPPWR website',
    build: 'Running build', version: 'Version', migrations: 'Migration level', channel: 'Release channel',
    builtAt: 'Built', unavailable: 'Not reachable from this page',
    fiction: 'ACME companies, products, suppliers and evidence are fictional and exist only for demonstration and testing.',
    assurance: 'OpenPPWR supports PPWR readiness and packaging compliance processes. It does not certify or guarantee legal compliance.',
  },
  pl: {
    demoLabel: 'Demonstracja', statusLabel: 'Status usługi', communityLabel: 'Community',
    docsLabel: 'Dokumentacja', productSite: 'Strona produktu', workbench: 'Obszar roboczy',
    language: 'Język', backToProduct: 'Strona produktu OpenPPWR', siteNav: 'Witryna OpenPPWR',
    build: 'Uruchomiony build', version: 'Wersja', migrations: 'Poziom migracji', channel: 'Kanał wydania',
    builtAt: 'Zbudowano', unavailable: 'Niedostępne z tej strony',
    fiction: 'Firmy, produkty, dostawcy i dowody ACME są fikcyjne i służą wyłącznie demonstracji oraz testom.',
    assurance: 'OpenPPWR wspiera gotowość do PPWR i procesy zgodności opakowań. Nie certyfikuje ani nie gwarantuje zgodności prawnej.',
  },
  de: {
    demoLabel: 'Demonstration', statusLabel: 'Dienststatus', communityLabel: 'Community',
    docsLabel: 'Dokumentation', productSite: 'Produktwebsite', workbench: 'Arbeitsbereich',
    language: 'Sprache', backToProduct: 'OpenPPWR Produktwebsite', siteNav: 'OpenPPWR-Website',
    build: 'Laufender Build', version: 'Version', migrations: 'Migrationsstand', channel: 'Release-Kanal',
    builtAt: 'Erstellt', unavailable: 'Von dieser Seite nicht erreichbar',
    fiction: 'ACME-Unternehmen, Produkte, Lieferanten und Nachweise sind fiktiv und dienen ausschließlich Demonstrations- und Testzwecken.',
    assurance: 'OpenPPWR unterstützt PPWR-Bereitschaft und Verpackungs-Compliance-Prozesse. Es zertifiziert oder garantiert keine Rechtskonformität.',
  },
};

// The demonstration landing. Its job is to explain what the guided run shows, which role sees which
// part, and how to get into it — not to sell the product again.
export const demoCopy = {
  en: {
    eyebrow: 'Guided demonstration · fictional ACME data',
    title: 'Run the whole compliance chain on data that cannot hurt anyone.',
    summary: 'ACME Packaging is invented. Its portfolio, suppliers, declarations and gaps exist so the workflow can be exercised end to end, reset, and exercised again. Nothing here is a customer record.',
    enter: 'Open the demonstration workbench',
    stepsTitle: 'What the guided run covers',
    steps: [
      ['Import', 'Load 32 packaging records from JSON or CSV. An invalid file is rejected row by row, and nothing is written.'],
      ['Catalogue', 'Inspect packaging, materials, components, bills of material and suppliers as persisted records.'],
      ['Evidence', 'Upload supplier declarations. Each is quarantined and scanned before anyone can review it.'],
      ['Review', 'Accept or reject evidence. An infected or expired file cannot be accepted, by refusal rather than by convention.'],
      ['Assessment', 'Run the rules. Every packaging record lands on PASS, FAIL, UNKNOWN or NOT APPLICABLE, with the exact rule version recorded.'],
      ['Remediation', 'Assign a gap, remediate it, reassess it, and watch the outcome change for a reason you can read.'],
      ['Dossier', 'Freeze the review, generate JSON, PDF and ZIP with a SHA-256 manifest, and verify the audit chain.'],
    ],
    rolesTitle: 'Sign in as the role whose part you want to see',
    rolesIntro: 'Seven accounts share one password, shown on the sign-in panel. Each one holds only the permissions its role is granted by the server.',
    resetTitle: 'Resetting',
    resetBody: 'The demonstration tenant can be returned to a clean state from inside the workbench. Uploaded files are removed with it, which is why the environment must never hold anything real.',
    accessTitle: 'Access',
    accessBody: 'Who may reach this environment is not something the software decides. It holds fictional data behind seven accounts sharing one published password, so it must never be left open to anonymous visitors — but the control that keeps it closed belongs to whoever runs it, not to this page.',
  },
  pl: {
    eyebrow: 'Prowadzona demonstracja · fikcyjne dane ACME',
    title: 'Przejdź cały łańcuch zgodności na danych, które nikomu nie zaszkodzą.',
    summary: 'ACME Packaging jest wymyślone. Portfolio, dostawcy, deklaracje i luki istnieją po to, by przejść proces od początku do końca, zresetować go i przejść ponownie. Nic tutaj nie jest danymi klienta.',
    enter: 'Otwórz obszar demonstracyjny',
    stepsTitle: 'Co obejmuje prowadzony przebieg',
    steps: [
      ['Import', 'Wczytaj 32 rekordy opakowań z JSON lub CSV. Niepoprawny plik jest odrzucany wiersz po wierszu i nic nie zostaje zapisane.'],
      ['Katalog', 'Obejrzyj opakowania, materiały, komponenty, struktury BOM i dostawców jako utrwalone rekordy.'],
      ['Dowody', 'Wgraj deklaracje dostawców. Każda trafia do kwarantanny i jest skanowana, zanim ktokolwiek ją oceni.'],
      ['Przegląd', 'Zaakceptuj lub odrzuć dowód. Pliku zainfekowanego lub przeterminowanego nie da się zaakceptować — przez odmowę, nie przez ustalenie.'],
      ['Ocena', 'Uruchom reguły. Każdy rekord otrzymuje PASS, FAIL, UNKNOWN albo NOT APPLICABLE, z zapisaną dokładną wersją reguły.'],
      ['Działania naprawcze', 'Przypisz lukę, wykonaj działanie, oceń ponownie i zobacz, jak wynik zmienia się z powodu, który da się przeczytać.'],
      ['Dokumentacja', 'Zamroź przegląd, wygeneruj JSON, PDF i ZIP z manifestem SHA-256 i zweryfikuj łańcuch audytu.'],
    ],
    rolesTitle: 'Zaloguj się rolą, której część chcesz zobaczyć',
    rolesIntro: 'Siedem kont dzieli jedno hasło, pokazane w panelu logowania. Każde ma wyłącznie uprawnienia przyznane tej roli przez serwer.',
    resetTitle: 'Reset',
    resetBody: 'Tenant demonstracyjny można przywrócić do stanu czystego z poziomu obszaru roboczego. Wgrane pliki znikają razem z nim — dlatego to środowisko nigdy nie może zawierać niczego prawdziwego.',
    accessTitle: 'Dostęp',
    accessBody: 'O tym, kto może dotrzeć do tego środowiska, nie decyduje oprogramowanie. Środowisko zawiera dane fikcyjne za siedmioma kontami ze wspólnym, jawnym hasłem, więc nigdy nie może pozostać otwarte dla anonimowych odwiedzających — ale mechanizm, który je zamyka, należy do podmiotu prowadzącego to wdrożenie, a nie do tej strony.',
  },
  de: {
    eyebrow: 'Geführte Demonstration · fiktive ACME-Daten',
    title: 'Die gesamte Compliance-Kette an Daten durchlaufen, die niemandem schaden können.',
    summary: 'ACME Packaging ist erfunden. Portfolio, Lieferanten, Erklärungen und Lücken existieren, damit der Ablauf vollständig durchlaufen, zurückgesetzt und erneut durchlaufen werden kann. Nichts davon ist ein Kundendatensatz.',
    enter: 'Demonstrations-Arbeitsbereich öffnen',
    stepsTitle: 'Was der geführte Durchlauf abdeckt',
    steps: [
      ['Import', '32 Verpackungsdatensätze aus JSON oder CSV laden. Eine ungültige Datei wird zeilenweise abgelehnt, und es wird nichts geschrieben.'],
      ['Katalog', 'Verpackungen, Materialien, Komponenten, Stücklisten und Lieferanten als persistierte Datensätze ansehen.'],
      ['Nachweise', 'Lieferantenerklärungen hochladen. Jede wird in Quarantäne genommen und geprüft, bevor sie jemand bewerten kann.'],
      ['Prüfung', 'Nachweise annehmen oder ablehnen. Eine infizierte oder abgelaufene Datei kann nicht angenommen werden — durch Verweigerung, nicht durch Vereinbarung.'],
      ['Bewertung', 'Regeln ausführen. Jeder Datensatz erhält PASS, FAIL, UNKNOWN oder NOT APPLICABLE, mit der exakt verwendeten Regelversion.'],
      ['Abhilfe', 'Eine Lücke zuweisen, beheben, neu bewerten und beobachten, wie sich das Ergebnis aus einem nachlesbaren Grund ändert.'],
      ['Dossier', 'Prüfung einfrieren, JSON, PDF und ZIP mit SHA-256-Manifest erzeugen und die Audit-Kette verifizieren.'],
    ],
    rolesTitle: 'Mit der Rolle anmelden, deren Teil Sie sehen möchten',
    rolesIntro: 'Sieben Konten teilen ein Passwort, das im Anmeldebereich angezeigt wird. Jedes besitzt nur die Berechtigungen, die der Server dieser Rolle gewährt.',
    resetTitle: 'Zurücksetzen',
    resetBody: 'Der Demonstrations-Mandant kann aus dem Arbeitsbereich heraus in einen sauberen Zustand versetzt werden. Hochgeladene Dateien verschwinden mit ihm — deshalb darf diese Umgebung niemals etwas Echtes enthalten.',
    accessTitle: 'Zugang',
    accessBody: 'Wer diese Umgebung erreichen darf, entscheidet nicht die Software. Sie enthält fiktive Daten hinter sieben Konten mit einem gemeinsamen, angezeigten Passwort und darf deshalb niemals anonym erreichbar bleiben — die Maßnahme, die sie verschließt, liegt jedoch beim Betreiber dieser Installation und nicht bei dieser Seite.',
  },
};

// The status page. It reports what is running and what is deliberately not offered. It does not
// invent uptime figures, because none are measured.
export const statusCopy = {
  en: {
    eyebrow: 'Service and release status',
    title: 'What is running, and what is not claimed.',
    summary: 'This page reads the running deployment. Every value below comes from the build itself, not from a content file.',
    componentsTitle: 'Components',
    components: [
      ['Web', 'Serves the product surfaces and proxies the API.'],
      ['API', 'Authentication, catalogue, evidence, assessment, dossier and audit.'],
      ['Worker', 'Evidence scanning and background jobs.'],
      ['PostgreSQL', 'Persistence with FORCE RLS tenant isolation.'],
      ['ClamAV', 'Malware scanning. Evidence cannot be reviewed until it has been scanned.'],
    ],
    notClaimedTitle: 'What this page does not claim',
    notClaimed: [
      'No uptime percentage is published, because none is measured.',
      'No incident history is published, because this page reports the running build and not the operating record of a service.',
      'No support response time is offered here. The support model is described in the documentation.',
    ],
    incidentsTitle: 'Incidents and maintenance',
    incidentsBody: 'None are recorded here. Incident and maintenance records, where they are kept at all, are kept by whoever operates this deployment; this page does not stand in for them.',
  },
  pl: {
    eyebrow: 'Status usługi i wydania',
    title: 'Co działa i czego nie deklarujemy.',
    summary: 'Ta strona odczytuje działające wdrożenie. Każda wartość poniżej pochodzi z samego builda, nie z pliku z treścią.',
    componentsTitle: 'Komponenty',
    components: [
      ['Web', 'Udostępnia powierzchnie produktu i pośredniczy w ruchu do API.'],
      ['API', 'Uwierzytelnianie, katalog, dowody, ocena, dokumentacja i audyt.'],
      ['Worker', 'Skanowanie dowodów i zadania w tle.'],
      ['PostgreSQL', 'Trwałość z izolacją tenantów przez FORCE RLS.'],
      ['ClamAV', 'Skanowanie antywirusowe. Dowodu nie da się ocenić przed przeskanowaniem.'],
    ],
    notClaimedTitle: 'Czego ta strona nie deklaruje',
    notClaimed: [
      'Nie publikujemy procentu dostępności, bo nie jest mierzony.',
      'Nie publikujemy historii incydentów — ta strona raportuje uruchomiony build, a nie zapis eksploatacji usługi.',
      'Nie podajemy tu czasu reakcji wsparcia. Model wsparcia opisuje dokumentacja.',
    ],
    incidentsTitle: 'Incydenty i prace serwisowe',
    incidentsBody: 'W tym miejscu nie ma żadnych zapisów. Rejestry incydentów i prac serwisowych — o ile w ogóle są prowadzone — prowadzi podmiot eksploatujący to wdrożenie; ta strona ich nie zastępuje.',
  },
  de: {
    eyebrow: 'Dienst- und Release-Status',
    title: 'Was läuft, und was nicht behauptet wird.',
    summary: 'Diese Seite liest das laufende Deployment. Jeder Wert unten stammt aus dem Build selbst, nicht aus einer Inhaltsdatei.',
    componentsTitle: 'Komponenten',
    components: [
      ['Web', 'Liefert die Produktoberflächen und leitet die API weiter.'],
      ['API', 'Authentifizierung, Katalog, Nachweise, Bewertung, Dossier und Audit.'],
      ['Worker', 'Nachweisprüfung und Hintergrundjobs.'],
      ['PostgreSQL', 'Persistenz mit Mandantentrennung über FORCE RLS.'],
      ['ClamAV', 'Malware-Prüfung. Ein Nachweis kann vor der Prüfung nicht bewertet werden.'],
    ],
    notClaimedTitle: 'Was diese Seite nicht behauptet',
    notClaimed: [
      'Es wird keine Verfügbarkeitsquote veröffentlicht, weil keine gemessen wird.',
      'Es wird keine Störungshistorie veröffentlicht, weil diese Seite den laufenden Build ausweist und nicht den Betriebsnachweis eines Dienstes.',
      'Hier werden keine Support-Reaktionszeiten zugesagt. Das Support-Modell beschreibt die Dokumentation.',
    ],
    incidentsTitle: 'Störungen und Wartung',
    incidentsBody: 'Hier sind keine erfasst. Störungs- und Wartungsaufzeichnungen führt, soweit überhaupt vorhanden, der Betreiber dieses Deployments; diese Seite ersetzt sie nicht.',
  },
};

// The Community entry point.
//
// This page previously announced that the source had not been published and that the deployment was
// a private release candidate. Both were facts about one moment in Attentus's own release process,
// baked into a bundle that every operator installs: on a third-party installation the first was
// unknowable and the second was simply false, and on the day of a public release the front page of
// the published product would have asserted that it was not published.
//
// The release state is therefore no longer written here at all. It is read from the running build
// and rendered in the build stamp this page already carries, so there is exactly one place where it
// can be right or wrong, and it is the place that knows.
export const communityCopy = {
  en: {
    eyebrow: 'Community edition',
    title: 'OpenPPWR Community: the whole workflow, self-hosted, Apache-2.0.',
    summary: 'Community is the complete packaging readiness workflow, licensed under Apache-2.0 and running on infrastructure its operator controls. This page describes what the edition contains and what it does not.',
    stateTitle: 'Current state',
    state: [
      ['Licence', 'Apache-2.0 for the code. The OpenPPWR name and marks are governed separately by TRADEMARKS.md; the licence grants no brand rights.'],
      ['Release state', 'Read from the running build rather than written here: the version, revision and release channel appear in the build stamp at the foot of this page. A page cannot know which build will serve it, so it does not claim one.'],
      ['Support', 'Self-support. Community carries no service level, no response-time commitment and no availability figure for support. The one exception is the security disclosure channel, which does publish triage targets: security@openppwr.eu, and the same targets are in SECURITY.md.'],
    ],
    contentsTitle: 'What Community contains',
    contents: [
      'The complete packaging readiness workflow: import, evidence, assessment, remediation, review and dossier.',
      'Self-hosted API, worker, web and PostgreSQL, with a clean-server installer for Debian 13.',
      'A transparent demonstration rule pack, which is deliberately small and is not authoritative regulatory content.',
      'Backup, restore, versioned upgrade and rollback procedures.',
    ],
    excludedTitle: 'What Community does not contain',
    excluded: [
      'Maintained regulatory rule subscriptions.',
      'Managed operation, which is the Cloud edition.',
      'ERP and SAP connectors, which are the Connect edition.',
      'Advanced identity and governance controls, which are the Enterprise edition.',
    ],
  },
  pl: {
    eyebrow: 'Edycja Community',
    title: 'OpenPPWR Community: cały proces, self-hosted, Apache-2.0.',
    summary: 'Community to kompletny proces gotowości opakowań na licencji Apache-2.0, działający na infrastrukturze kontrolowanej przez podmiot, który go prowadzi. Ta strona opisuje, co edycja zawiera, a czego nie.',
    stateTitle: 'Stan bieżący',
    state: [
      ['Licencja', 'Apache-2.0 dla kodu. Nazwa i znaki OpenPPWR podlegają odrębnie dokumentowi TRADEMARKS.md; licencja nie przyznaje praw do marki.'],
      ['Stan wydania', 'Odczytywany z uruchomionego builda, a nie zapisany w tym tekście: wersja, rewizja i kanał wydania są widoczne w stopce tej strony. Strona nie wie, który build ją poda, więc niczego o nim nie deklaruje.'],
      ['Wsparcie', 'Wsparcie własne. Community nie obejmuje umowy o poziomie usług, zobowiązania co do czasu reakcji ani deklaracji dostępności wsparcia. Jedynym wyjątkiem jest kanał zgłaszania podatności, dla którego publikujemy docelowe terminy triage: security@openppwr.eu, a te same terminy zawiera plik SECURITY.md.'],
    ],
    contentsTitle: 'Co zawiera Community',
    contents: [
      'Kompletny proces gotowości opakowań: import, dowody, ocena, działania naprawcze, przegląd i dokumentacja.',
      'Self-hosted API, worker, web i PostgreSQL, z instalatorem czystego serwera dla Debian 13.',
      'Przejrzysty demonstracyjny pakiet reguł, celowo mały i nie stanowiący autorytatywnej treści regulacyjnej.',
      'Procedury backupu, odtworzenia, wersjonowanego upgrade i rollbacku.',
    ],
    excludedTitle: 'Czego Community nie zawiera',
    excluded: [
      'Utrzymywanych subskrypcji reguł regulacyjnych.',
      'Zarządzanej eksploatacji — to edycja Cloud.',
      'Konektorów ERP i SAP — to edycja Connect.',
      'Zaawansowanych kontroli tożsamości i governance — to edycja Enterprise.',
    ],
  },
  de: {
    eyebrow: 'Community-Edition',
    title: 'OpenPPWR Community: der vollständige Ablauf, selbst gehostet, Apache-2.0.',
    summary: 'Community ist der vollständige Ablauf zur Verpackungsbereitschaft, lizenziert unter Apache-2.0 und betrieben auf Infrastruktur, die der jeweilige Betreiber kontrolliert. Diese Seite beschreibt, was die Edition enthält und was nicht.',
    stateTitle: 'Aktueller Stand',
    state: [
      ['Lizenz', 'Apache-2.0 für den Code. Name und Marken von OpenPPWR regelt gesondert TRADEMARKS.md; die Lizenz gewährt keine Markenrechte.'],
      ['Release-Status', 'Aus dem laufenden Build gelesen und nicht hier festgeschrieben: Version, Revision und Release-Kanal stehen im Build-Stempel am Fuß dieser Seite. Eine Seite kann nicht wissen, welcher Build sie ausliefert, und behauptet es deshalb nicht.'],
      ['Support', 'Self-Support. Community umfasst keine Servicevereinbarung, keine Reaktionszeitzusage und keine Verfügbarkeitsangabe für den Support. Die einzige Ausnahme ist der Kanal für Schwachstellenmeldungen, für den Ziele zur Ersteinschätzung veröffentlicht sind: security@openppwr.eu, und dieselben Ziele stehen in der Datei SECURITY.md.'],
    ],
    contentsTitle: 'Was Community enthält',
    contents: [
      'Den vollständigen Ablauf zur Verpackungsbereitschaft: Import, Nachweise, Bewertung, Abhilfe, Prüfung und Dossier.',
      'Selbst gehostete API, Worker, Web und PostgreSQL, mit Installer für einen frischen Debian-13-Server.',
      'Ein transparentes Demonstrations-Regelpaket, bewusst klein und keine autoritative regulatorische Inhalte.',
      'Verfahren für Backup, Wiederherstellung, versioniertes Upgrade und Rollback.',
    ],
    excludedTitle: 'Was Community nicht enthält',
    excluded: [
      'Gepflegte regulatorische Regel-Abonnements.',
      'Verwalteten Betrieb — das ist die Cloud-Edition.',
      'ERP- und SAP-Konnektoren — das ist die Connect-Edition.',
      'Erweiterte Identitäts- und Governance-Kontrollen — das ist die Enterprise-Edition.',
    ],
  },
};

export function surfaceText(source, locale) {
  return source[locale] || source.en;
}
