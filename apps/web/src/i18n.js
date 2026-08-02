export const DEFAULT_LOCALE='en';
export const SUPPORTED_LOCALES=['en','pl','de'];

export const catalogs={
  en:{title:'OpenPPWR Community',eyebrow:'Packaging readiness workbench',fiction:'This workspace contains fictional data generated exclusively for demonstration and testing.',credential:'Access credential',credentialHint:'Credentials stay in this browser tab and determine permitted actions.',workflow:'Reference workflow',language:'Language',signOut:'Clear credential',importTitle:'Import packaging',importHelp:'Validate every row, then commit the catalog as one transaction.',format:'Format',idempotency:'Idempotency key',payload:'Import payload',runImport:'Validate and import',evidenceTitle:'Build evidence',evidenceHelp:'Upload to quarantine, wait for a clean scan, then review.',loadRequirements:'Load requirements',requirement:'Evidence requirement',file:'Evidence file',upload:'Upload to quarantine',refreshEvidence:'Refresh evidence',accept:'Accept',reject:'Reject',assessmentTitle:'Assess packaging',assessmentHelp:'Run the exact Community rule version and retain its input and evidence snapshot.',runAssessment:'Run assessment',gapsTitle:'Resolve gaps',gapsHelp:'Assign ownership, record remediation, then reassess. Closed gaps remain in history.',loadGaps:'Load gaps',owner:'Remediation owner ID',assign:'Assign',remediate:'Record remediation',reassess:'Reassess',dossierTitle:'Freeze and export',dossierHelp:'The dossier is generated only from a ready, frozen review snapshot.',freeze:'Freeze ready-for-review snapshot',generate:'Generate dossier',download:'Download',verifyAudit:'Verify audit chain',status:'Activity evidence',empty:'No result yet.',actions:'Actions',downloadFailed:'Download failed'},
  pl:{title:'OpenPPWR Community',eyebrow:'Obszar roboczy gotowości opakowań',fiction:'Ten obszar zawiera fikcyjne dane wygenerowane wyłącznie do celów demonstracyjnych i testowych.',credential:'Dane dostępowe',credentialHint:'Dane dostępowe pozostają w tej karcie przeglądarki i określają dozwolone działania.',workflow:'Proces referencyjny',language:'Język',signOut:'Wyczyść dane dostępowe',importTitle:'Import opakowań',importHelp:'Sprawdź każdy wiersz, a następnie zapisz katalog w jednej transakcji.',format:'Format',idempotency:'Klucz idempotencji',payload:'Dane importu',runImport:'Sprawdź i importuj',evidenceTitle:'Zbierz dowody',evidenceHelp:'Prześlij do kwarantanny, poczekaj na wynik skanowania i wykonaj przegląd.',loadRequirements:'Wczytaj wymagania',requirement:'Wymagany dowód',file:'Plik dowodu',upload:'Prześlij do kwarantanny',refreshEvidence:'Odśwież dowody',accept:'Zatwierdź',reject:'Odrzuć',assessmentTitle:'Oceń opakowania',assessmentHelp:'Uruchom dokładną wersję reguły Community i zachowaj migawkę danych oraz dowodów.',runAssessment:'Uruchom ocenę',gapsTitle:'Usuń luki',gapsHelp:'Przypisz właściciela, zapisz działania naprawcze i wykonaj ponowną ocenę. Zamknięte luki pozostają w historii.',loadGaps:'Wczytaj luki',owner:'Identyfikator właściciela',assign:'Przypisz',remediate:'Zapisz działanie',reassess:'Oceń ponownie',dossierTitle:'Zamroź i eksportuj',dossierHelp:'Dokumentacja jest generowana wyłącznie z gotowej, zamrożonej migawki przeglądu.',freeze:'Zamroź migawkę gotową do przeglądu',generate:'Generuj dokumentację',download:'Pobierz',verifyAudit:'Sprawdź łańcuch audytu',status:'Przebieg operacji',empty:'Brak wyniku.',actions:'Działania',downloadFailed:'Pobieranie nie powiodło się'},
  de:{title:'OpenPPWR Community',eyebrow:'Arbeitsbereich für Verpackungsbereitschaft',fiction:'Dieser Arbeitsbereich enthält ausschließlich fiktive, zu Demonstrations- und Testzwecken erzeugte Daten.',credential:'Zugangsdaten',credentialHint:'Die Zugangsdaten verbleiben in diesem Browser-Tab und bestimmen die zulässigen Aktionen.',workflow:'Referenzablauf',language:'Sprache',signOut:'Zugangsdaten löschen',importTitle:'Verpackungen importieren',importHelp:'Jede Zeile prüfen und den Katalog anschließend in einer Transaktion speichern.',format:'Format',idempotency:'Idempotenzschlüssel',payload:'Importdaten',runImport:'Prüfen und importieren',evidenceTitle:'Nachweise erfassen',evidenceHelp:'In die Quarantäne hochladen, die saubere Prüfung abwarten und anschließend bewerten.',loadRequirements:'Anforderungen laden',requirement:'Nachweisanforderung',file:'Nachweisdatei',upload:'In Quarantäne hochladen',refreshEvidence:'Nachweise aktualisieren',accept:'Annehmen',reject:'Ablehnen',assessmentTitle:'Verpackungen bewerten',assessmentHelp:'Die genaue Community-Regelversion ausführen und Eingabe- sowie Nachweis-Snapshot aufbewahren.',runAssessment:'Bewertung starten',gapsTitle:'Lücken bearbeiten',gapsHelp:'Verantwortung zuweisen, Abhilfe dokumentieren und erneut bewerten. Geschlossene Lücken bleiben im Verlauf.',loadGaps:'Lücken laden',owner:'ID der verantwortlichen Person',assign:'Zuweisen',remediate:'Abhilfe erfassen',reassess:'Neu bewerten',dossierTitle:'Einfrieren und exportieren',dossierHelp:'Das Dossier wird nur aus einem bereiten, eingefrorenen Review-Snapshot erzeugt.',freeze:'Review-bereiten Snapshot einfrieren',generate:'Dossier erzeugen',download:'Herunterladen',verifyAudit:'Audit-Kette prüfen',status:'Aktivitätsnachweis',empty:'Noch kein Ergebnis.',actions:'Aktionen',downloadFailed:'Download fehlgeschlagen'},
};

const catalogLabels={
  en:{catalogTitle:'Inspect catalog',catalogHelp:'Confirm persisted packaging, material, component, BOM and supplier records.',loadCatalog:'Load catalog summary',packaging:'Packaging',materials:'Materials',components:'Components',boms:'BOMs',suppliers:'Suppliers'},
  pl:{catalogTitle:'Sprawd\u017a katalog',catalogHelp:'Potwierd\u017a zapisane opakowania, materia\u0142y, komponenty, zestawienia materia\u0142owe i dostawc\u00f3w.',loadCatalog:'Wczytaj podsumowanie katalogu',packaging:'Opakowania',materials:'Materia\u0142y',components:'Komponenty',boms:'Zestawienia materia\u0142owe',suppliers:'Dostawcy'},
  de:{catalogTitle:'Katalog pr\u00fcfen',catalogHelp:'Gespeicherte Verpackungen, Materialien, Komponenten, St\u00fccklisten und Lieferanten best\u00e4tigen.',loadCatalog:'Katalog\u00fcbersicht laden',packaging:'Verpackungen',materials:'Materialien',components:'Komponenten',boms:'St\u00fccklisten',suppliers:'Lieferanten'},
};
for(const locale of SUPPORTED_LOCALES)Object.assign(catalogs[locale],catalogLabels[locale]);


// Authentication, session and professional error states for the workbench.
const sessionLabels={
  en:{
    signInTitle:'Sign in to the workbench',
    signInHelp:'The workbench requires an OpenPPWR access credential. The installer issues one for each role when the ACME demonstration tenant is created; it is printed by the deployment operator, never published.',
    signInAction:'Verify credential',
    verifying:'Verifying credential…',
    signedInAs:'Signed in',
    role:'Role',
    tenant:'Tenant',
    notSignedIn:'Not signed in',
    lockedHint:'Sign in to enable the workflow actions below.',
    technicalDetails:'Technical details',
    supportReference:'Support reference',
    errAuthRequired:'You are not signed in. Enter a valid access credential to continue.',
    errAuthFailed:'This access credential is not valid. It may have been mistyped, or it may belong to a deployment that has since been reset. Request a current credential from the deployment operator.',
    errForbidden:'The operation could not be completed. The resource does not exist or is not available to your role.',
    errRateLimited:'Too many requests. Wait a moment and try again.',
    errInvalidInput:'The submitted data was rejected. Review the reported rows and correct them before importing again.',
    errTooLarge:'The submitted content exceeds the permitted size.',
    errConflict:'This action conflicts with the current state and was not applied.',
    errServer:'The service could not complete the request. Retry shortly; if it persists, quote the support reference below.',
    errNetwork:'The service could not be reached. Check that the deployment is running and try again.',
  },
  pl:{
    signInTitle:'Zaloguj się do obszaru roboczego',
    signInHelp:'Obszar roboczy wymaga danych dostępowych OpenPPWR. Instalator wydaje je dla każdej roli podczas tworzenia demonstracyjnej organizacji ACME; przekazuje je operator wdrożenia i nie są publikowane.',
    signInAction:'Zweryfikuj dane dostępowe',
    verifying:'Trwa weryfikacja danych dostępowych…',
    signedInAs:'Zalogowano',
    role:'Rola',
    tenant:'Organizacja',
    notSignedIn:'Nie zalogowano',
    lockedHint:'Zaloguj się, aby udostępnić działania procesu poniżej.',
    technicalDetails:'Szczegóły techniczne',
    supportReference:'Identyfikator zgłoszenia',
    errAuthRequired:'Nie jesteś zalogowany. Podaj prawidłowe dane dostępowe, aby kontynuować.',
    errAuthFailed:'Te dane dostępowe są nieprawidłowe. Mogły zostać wpisane błędnie albo pochodzą z wdrożenia, które zostało zresetowane. Poproś operatora wdrożenia o aktualne dane dostępowe.',
    errForbidden:'Nie można wykonać tej operacji. Zasób nie istnieje albo nie jest dostępny dla Twojej roli.',
    errRateLimited:'Zbyt wiele żądań. Odczekaj chwilę i spróbuj ponownie.',
    errInvalidInput:'Przesłane dane zostały odrzucone. Sprawdź wskazane wiersze i popraw je przed ponownym importem.',
    errTooLarge:'Przesłana treść przekracza dopuszczalny rozmiar.',
    errConflict:'To działanie jest sprzeczne z bieżącym stanem i nie zostało wykonane.',
    errServer:'Usługa nie mogła zrealizować żądania. Spróbuj ponownie za chwilę, a jeżeli problem będzie się powtarzał, podaj poniższy identyfikator zgłoszenia.',
    errNetwork:'Nie można połączyć się z usługą. Sprawdź, czy wdrożenie działa, i spróbuj ponownie.',
  },
  de:{
    signInTitle:'Am Arbeitsbereich anmelden',
    signInHelp:'Der Arbeitsbereich erfordert OpenPPWR-Zugangsdaten. Der Installer stellt sie beim Anlegen der ACME-Demonstrationsorganisation je Rolle aus; sie werden vom Betreiber der Installation übergeben und nicht veröffentlicht.',
    signInAction:'Zugangsdaten prüfen',
    verifying:'Zugangsdaten werden geprüft…',
    signedInAs:'Angemeldet',
    role:'Rolle',
    tenant:'Organisation',
    notSignedIn:'Nicht angemeldet',
    lockedHint:'Melden Sie sich an, um die nachfolgenden Ablaufaktionen freizuschalten.',
    technicalDetails:'Technische Details',
    supportReference:'Support-Referenz',
    errAuthRequired:'Sie sind nicht angemeldet. Geben Sie gültige Zugangsdaten ein, um fortzufahren.',
    errAuthFailed:'Diese Zugangsdaten sind ungültig. Möglicherweise wurden sie falsch eingegeben oder sie stammen aus einer Installation, die zwischenzeitlich zurückgesetzt wurde. Fordern Sie aktuelle Zugangsdaten beim Betreiber der Installation an.',
    errForbidden:'Der Vorgang konnte nicht abgeschlossen werden. Die Ressource ist nicht vorhanden oder für Ihre Rolle nicht verfügbar.',
    errRateLimited:'Zu viele Anfragen. Warten Sie einen Moment und versuchen Sie es erneut.',
    errInvalidInput:'Die übermittelten Daten wurden abgelehnt. Prüfen Sie die gemeldeten Zeilen und korrigieren Sie diese vor einem erneuten Import.',
    errTooLarge:'Der übermittelte Inhalt überschreitet die zulässige Größe.',
    errConflict:'Diese Aktion steht im Widerspruch zum aktuellen Zustand und wurde nicht ausgeführt.',
    errServer:'Der Dienst konnte die Anfrage nicht abschließen. Versuchen Sie es in Kürze erneut; bei anhaltendem Problem geben Sie die untenstehende Support-Referenz an.',
    errNetwork:'Der Dienst ist nicht erreichbar. Prüfen Sie, ob die Installation läuft, und versuchen Sie es erneut.',
  },
};
for(const locale of SUPPORTED_LOCALES)Object.assign(catalogs[locale],sessionLabels[locale]);

// Maps a server error code to a professional, localized explanation. Unknown codes fall back to
// the generic service message rather than exposing raw technical text to the user.
const ERROR_MESSAGE_KEYS={
  AUTHENTICATION_REQUIRED:'errAuthRequired',
  AUTHENTICATION_FAILED:'errAuthFailed',
  BOOTSTRAP_UNAUTHORIZED:'errAuthFailed',
  RESOURCE_NOT_FOUND:'errForbidden',
  RATE_LIMITED:'errRateLimited',
  REQUEST_TOO_LARGE:'errTooLarge',
  BOOTSTRAP_ALREADY_COMPLETED:'errConflict',
  CLIENT_NETWORK_ERROR:'errNetwork',
  // The gap and scan-queue codes reached the user as the generic import message: a 422 from
  // `POST /v1/gaps/{id}/assign` was explained with "review the reported rows and correct them before
  // importing again", which describes a different operation entirely and told the user nothing about
  // the owner identifier that was actually rejected.
  GAP_OWNER_INVALID:'errGapOwnerInvalid',
  GAP_OWNER_REQUIRED:'errGapOwnerRequired',
  RECYCLED_CONTENT_INVALID:'errRecycledContent',
  EVIDENCE_NOT_CLEAN:'errEvidenceNotClean',
  EVIDENCE_EXPIRED:'errEvidenceExpired',
  SCAN_JOB_NOT_DEAD:'errScanJobNotDead',
  // The refusal the workbench produces most often, and the one that read worst. Freezing a review with
  // blocking gaps still open answers 409, which fell through to the generic conflict message — "This
  // action conflicts with the current state and was not applied" — which names neither the gaps nor the
  // step that closes them. The product owner met exactly this and could not tell it from a fault.
  READY_FOR_REVIEW_BLOCKED:'errReviewBlocked',
  READY_FOR_REVIEW_INCOMPLETE:'errReviewIncomplete',
};

export function errorMessageKey(code,status){
  if(code&&ERROR_MESSAGE_KEYS[code])return ERROR_MESSAGE_KEYS[code];
  if(status===401)return 'errAuthRequired';
  if(status===403||status===404)return 'errForbidden';
  if(status===409)return 'errConflict';
  if(status===413)return 'errTooLarge';
  if(status===422)return 'errInvalidInput';
  if(status===429)return 'errRateLimited';
  return 'errServer';
}

export function describeError(locale,{code,status}={}){return translate(locale,errorMessageKey(code,status));}


// Interactive sign-in and environment reset.
const loginLabels={
  en:{
    email:'Email',password:'Password',signIn:'Sign in',signingIn:'Signing in…',
    signInIntro:'Sign in with the demonstration account provided with this environment.',
    advancedToken:'Sign in with an access token instead',
    resetTitle:'Reset environment',
    resetHelp:'Restores the demonstration environment to its initial state. All imported packaging, evidence, assessments, gaps and dossiers in this environment are deleted. Your sign-in continues to work.',
    resetAction:'Reset environment to initial state',
    resetConfirm:'This deletes all demonstration data in this environment. Continue?',
    resetting:'Resetting…',resetDone:'Environment reset. Import the sample data again to start a new run.',
  },
  pl:{
    email:'Adres e-mail',password:'Hasło',signIn:'Zaloguj się',signingIn:'Trwa logowanie…',
    signInIntro:'Zaloguj się przy użyciu konta demonstracyjnego udostępnionego wraz z tym środowiskiem.',
    advancedToken:'Zaloguj się przy użyciu tokena dostępowego',
    resetTitle:'Reset środowiska',
    resetHelp:'Przywraca środowisko demonstracyjne do stanu początkowego. Wszystkie zaimportowane opakowania, dowody, oceny, luki i pakiety dokumentacyjne w tym środowisku zostaną usunięte. Twoje zalogowanie pozostaje aktywne.',
    resetAction:'Przywróć środowisko do stanu początkowego',
    resetConfirm:'Ta operacja usunie wszystkie dane demonstracyjne w tym środowisku. Kontynuować?',
    resetting:'Trwa resetowanie…',resetDone:'Środowisko zostało zresetowane. Zaimportuj dane przykładowe ponownie, aby rozpocząć nowy przebieg.',
  },
  de:{
    email:'E-Mail-Adresse',password:'Passwort',signIn:'Anmelden',signingIn:'Anmeldung läuft…',
    signInIntro:'Melden Sie sich mit dem Demonstrationskonto an, das zu dieser Umgebung gehört.',
    advancedToken:'Stattdessen mit einem Zugriffstoken anmelden',
    resetTitle:'Umgebung zurücksetzen',
    resetHelp:'Setzt die Demonstrationsumgebung in den Ausgangszustand zurück. Alle importierten Verpackungen, Nachweise, Bewertungen, Lücken und Dossiers in dieser Umgebung werden gelöscht. Ihre Anmeldung bleibt bestehen.',
    resetAction:'Umgebung auf den Ausgangszustand zurücksetzen',
    resetConfirm:'Dadurch werden alle Demonstrationsdaten in dieser Umgebung gelöscht. Fortfahren?',
    resetting:'Zurücksetzen läuft…',resetDone:'Die Umgebung wurde zurückgesetzt. Importieren Sie die Beispieldaten erneut, um einen neuen Durchlauf zu starten.',
  },
};
for(const locale of SUPPORTED_LOCALES)Object.assign(catalogs[locale],loginLabels[locale]);


// Artifact names, table headers, enum values and demo credentials. Raw enum values such as
// "infected" or "pending" must never reach a Polish or German screen.
const workbenchLabels={
  en:{
    skipToContent:'Skip to main content',
    loadDossiers:'Load frozen reviews',
    sessionExpires:'Session expires',
    sessionStatic:'Operator credential — no automatic expiry',
    switchRole:'Switch demo role',
    auditValid:'The audit chain has been verified.',
    auditInvalid:'The audit chain could not be verified.',
    auditCoverage:'All {count} events form a consistent, unaltered record of the process.',
    auditFailedAt:'The recorded sequence does not match its own hashes. Treat the affected review as unreliable and report it.',
    auditRange:'Period covered',
    auditSnapshot:'Frozen review',
    col_currency:'Version status',
    val_draft:'Draft',
    val_approved:'Approved',
    val_withdrawn:'Withdrawn',
    val_completed:'Completed',
    val_failed:'Failed',
    val_dead:'Abandoned',
    val_reopened:'Reopened',
    val_active:'Active',
    val_inactive:'Inactive',
    val_pass:'Compliant',
    val_fail:'Non-compliant',
    val_not_applicable:'Not applicable',
    val_current:'Current version',
    val_superseded:'Superseded',
    demoTitle:'Demonstration accounts',
    demoIntro:'This environment contains fictional ACME data only. Choose a role to fill in the sign-in form, then press Sign in.',
    demoPassword:'Password for every account',
    demoUse:'Use this role',
    role_compliance_manager:'Compliance manager',
    role_tenant_admin:'Tenant administrator',
    role_packaging_editor:'Packaging editor',
    role_evidence_contributor:'Evidence contributor',
    role_evidence_reviewer:'Evidence reviewer',
    role_read_only_auditor:'Read-only auditor',
    role_supplier_user:'Supplier user',
    roleUse_compliance_manager:'Runs the whole workflow: import, assess, remediate, freeze and generate the dossier. Start here.',
    roleUse_tenant_admin:'Full administration, including requeueing a stalled scan.',
    roleUse_packaging_editor:'Imports and edits packaging data only.',
    roleUse_evidence_contributor:'Uploads supplier evidence documents.',
    roleUse_evidence_reviewer:'Approves or rejects uploaded evidence.',
    roleUse_read_only_auditor:'Reads everything and verifies the audit chain, changing nothing.',
    roleUse_supplier_user:'Sees only their own supplier’s records.',
    artifact_json:'Structured data (JSON)',artifact_pdf:'Review report (PDF)',
    artifact_zip:'Complete evidence package (ZIP)',artifact_manifest:'SHA-256 checksum manifest',
    artifactIntro:'Each artifact is generated from the frozen review snapshot and can be verified against the checksum manifest.',
    col_supplier_id:'Supplier ID',col_evidence_type:'Document type',col_scan_status:'Scan status',
    col_review_status:'Review status',col_version:'Version',col_packaging_id:'Packaging',
    col_deduplication_key:'Finding',col_status:'Status',col_owner_id:'Owner',col_actions:'Actions',
    val_clean:'No threat found',val_infected:'Threat detected',val_pending:'Awaiting scan',
    val_running:'Scanning',val_error:'Scan failed',val_timeout:'Scan timed out',
    val_quarantined:'Quarantined',val_accepted:'Approved',val_rejected:'Rejected',
    val_open:'Open',val_assigned:'Assigned',val_remediated:'Remediated',val_closed:'Closed',
    val_expired:'Expired',val_superseded:'Superseded',val_current:'Current',val_unknown:'Not determined',
  },
  pl:{
    skipToContent:'Przejdź do treści głównej',
    loadDossiers:'Wczytaj zamrożone przeglądy',
    sessionExpires:'Sesja wygasa',
    sessionStatic:'Dane dostępowe operatora — bez automatycznego wygaśnięcia',
    switchRole:'Zmień rolę demo',
    auditValid:'Łańcuch audytu został zweryfikowany.',
    auditInvalid:'Nie można zweryfikować łańcucha audytu.',
    auditCoverage:'Wszystkie zdarzenia ({count}) tworzą spójny, niezmieniony zapis procesu.',
    auditFailedAt:'Zapisana sekwencja nie zgadza się z własnymi skrótami. Potraktuj powiązany przegląd jako niewiarygodny i zgłoś sprawę.',
    auditRange:'Zakres czasu',
    auditSnapshot:'Zamrożony przegląd',
    col_currency:'Status wersji',
    val_draft:'Wersja robocza',
    val_approved:'Zatwierdzone',
    val_withdrawn:'Wycofane',
    val_completed:'Zakończone',
    val_failed:'Nie powiodło się',
    val_dead:'Porzucone',
    val_reopened:'Ponownie otwarta',
    val_active:'Aktywny',
    val_inactive:'Nieaktywny',
    val_pass:'Zgodne',
    val_fail:'Niezgodne',
    val_not_applicable:'Nie dotyczy',
    val_current:'Wersja aktualna',
    val_superseded:'Zastąpiona',
    demoTitle:'Konta demonstracyjne',
    demoIntro:'To środowisko zawiera wyłącznie fikcyjne dane ACME. Wybierz rolę, aby wypełnić formularz logowania, a następnie naciśnij Zaloguj się.',
    demoPassword:'Hasło do wszystkich kont',
    demoUse:'Użyj tej roli',
    role_compliance_manager:'Menedżer zgodności',
    role_tenant_admin:'Administrator organizacji',
    role_packaging_editor:'Redaktor danych opakowań',
    role_evidence_contributor:'Dostawca dowodów',
    role_evidence_reviewer:'Recenzent dowodów',
    role_read_only_auditor:'Audytor (tylko odczyt)',
    role_supplier_user:'Użytkownik dostawcy',
    roleUse_compliance_manager:'Prowadzi cały proces: import, ocena, usuwanie niezgodności, zamrożenie przeglądu i wygenerowanie dokumentacji. Zacznij tutaj.',
    roleUse_tenant_admin:'Pełna administracja, w tym ponowne kolejkowanie zatrzymanego skanowania.',
    roleUse_packaging_editor:'Importuje i edytuje wyłącznie dane opakowań.',
    roleUse_evidence_contributor:'Przesyła dokumenty dowodowe dostawców.',
    roleUse_evidence_reviewer:'Zatwierdza lub odrzuca przesłane dowody.',
    roleUse_read_only_auditor:'Przegląda wszystko i weryfikuje łańcuch audytowy, niczego nie zmieniając.',
    roleUse_supplier_user:'Widzi wyłącznie rekordy własnego dostawcy.',
    artifact_json:'Dane strukturalne (JSON)',artifact_pdf:'Raport przeglądu (PDF)',
    artifact_zip:'Kompletny pakiet dowodowy (ZIP)',artifact_manifest:'Manifest sum kontrolnych SHA-256',
    artifactIntro:'Każdy artefakt powstaje z zamrożonej migawki przeglądu i może zostać zweryfikowany względem manifestu sum kontrolnych.',
    col_supplier_id:'ID dostawcy',col_evidence_type:'Typ dokumentu dowodowego',col_scan_status:'Status skanowania',
    col_review_status:'Status przeglądu',col_version:'Wersja',col_packaging_id:'Opakowanie',
    col_deduplication_key:'Ustalenie',col_status:'Status',col_owner_id:'Właściciel',col_actions:'Działania',
    val_clean:'Nie wykryto zagrożeń',val_infected:'Wykryto zagrożenie',val_pending:'Oczekuje na skanowanie',
    val_running:'Skanowanie w toku',val_error:'Skanowanie nie powiodło się',val_timeout:'Przekroczono czas skanowania',
    val_quarantined:'W kwarantannie',val_accepted:'Zatwierdzono',val_rejected:'Odrzucono',
    val_open:'Otwarta',val_assigned:'Przypisana',val_remediated:'Usunięta',val_closed:'Zamknięta',
    val_expired:'Wygasł',val_superseded:'Zastąpiony',val_current:'Aktualny',val_unknown:'Nieustalony',
  },
  de:{
    skipToContent:'Zum Hauptinhalt springen',
    loadDossiers:'Eingefrorene Prüfungen laden',
    sessionExpires:'Sitzung läuft ab',
    sessionStatic:'Betriebszugang — kein automatischer Ablauf',
    switchRole:'Demo-Rolle wechseln',
    auditValid:'Die Audit-Kette wurde verifiziert.',
    auditInvalid:'Die Audit-Kette konnte nicht verifiziert werden.',
    auditCoverage:'Alle {count} Ereignisse bilden einen konsistenten, unveränderten Nachweis des Ablaufs.',
    auditFailedAt:'Die aufgezeichnete Reihenfolge stimmt nicht mit ihren eigenen Hashwerten überein. Behandeln Sie die betroffene Prüfung als nicht belastbar und melden Sie den Fall.',
    auditRange:'Erfasster Zeitraum',
    auditSnapshot:'Eingefrorene Prüfung',
    col_currency:'Versionsstatus',
    val_draft:'Entwurf',
    val_approved:'Genehmigt',
    val_withdrawn:'Zurückgezogen',
    val_completed:'Abgeschlossen',
    val_failed:'Fehlgeschlagen',
    val_dead:'Abgebrochen',
    val_reopened:'Wieder geöffnet',
    val_active:'Aktiv',
    val_inactive:'Inaktiv',
    val_pass:'Konform',
    val_fail:'Nicht konform',
    val_not_applicable:'Nicht zutreffend',
    val_current:'Aktuelle Version',
    val_superseded:'Ersetzt',
    demoTitle:'Demonstrationskonten',
    demoIntro:'Diese Umgebung enthält ausschließlich fiktive ACME-Daten. Wählen Sie eine Rolle, um das Anmeldeformular zu füllen, und klicken Sie dann auf Anmelden.',
    demoPassword:'Passwort für alle Konten',
    demoUse:'Diese Rolle verwenden',
    role_compliance_manager:'Compliance-Manager',
    role_tenant_admin:'Mandantenadministrator',
    role_packaging_editor:'Verpackungsdaten-Redakteur',
    role_evidence_contributor:'Nachweis-Lieferant',
    role_evidence_reviewer:'Nachweisprüfer',
    role_read_only_auditor:'Auditor (nur Lesen)',
    role_supplier_user:'Lieferantenbenutzer',
    roleUse_compliance_manager:'Führt den gesamten Ablauf durch: Import, Bewertung, Behebung, Einfrieren und Erzeugung des Dossiers. Hier beginnen.',
    roleUse_tenant_admin:'Vollständige Administration, einschließlich der erneuten Einplanung eines hängengebliebenen Scans.',
    roleUse_packaging_editor:'Importiert und bearbeitet ausschließlich Verpackungsdaten.',
    roleUse_evidence_contributor:'Lädt Nachweisdokumente von Lieferanten hoch.',
    roleUse_evidence_reviewer:'Gibt hochgeladene Nachweise frei oder lehnt sie ab.',
    roleUse_read_only_auditor:'Sieht alles und verifiziert die Audit-Kette, ohne etwas zu verändern.',
    roleUse_supplier_user:'Sieht ausschließlich die Datensätze des eigenen Lieferanten.',
    artifact_json:'Strukturierte Daten (JSON)',artifact_pdf:'Prüfbericht (PDF)',
    artifact_zip:'Vollständiges Nachweispaket (ZIP)',artifact_manifest:'SHA-256-Prüfsummenmanifest',
    artifactIntro:'Jedes Artefakt wird aus dem eingefrorenen Prüf-Snapshot erzeugt und kann anhand des Prüfsummenmanifests verifiziert werden.',
    col_supplier_id:'Lieferanten-ID',col_evidence_type:'Nachweisart',col_scan_status:'Scan-Status',
    col_review_status:'Prüfstatus',col_version:'Version',col_packaging_id:'Verpackung',
    col_deduplication_key:'Feststellung',col_status:'Status',col_owner_id:'Verantwortlich',col_actions:'Aktionen',
    val_clean:'Keine Bedrohung gefunden',val_infected:'Bedrohung erkannt',val_pending:'Wartet auf Prüfung',
    val_running:'Prüfung läuft',val_error:'Prüfung fehlgeschlagen',val_timeout:'Zeitüberschreitung bei der Prüfung',
    val_quarantined:'In Quarantäne',val_accepted:'Freigegeben',val_rejected:'Abgelehnt',
    val_open:'Offen',val_assigned:'Zugewiesen',val_remediated:'Behoben',val_closed:'Geschlossen',
    val_expired:'Abgelaufen',val_superseded:'Ersetzt',val_current:'Aktuell',val_unknown:'Nicht bestimmt',
  },
};
for(const locale of SUPPORTED_LOCALES)Object.assign(catalogs[locale],workbenchLabels[locale]);

// Step 05, the evidence document and the scan queue.
//
// Three defects share this block. The remediation button posted a fixed recycled-content figure and a
// hard-coded English note into the immutable audit chain, so the fields it writes are now stated by the
// user. The owner field demanded an identity UUID the interface never displayed, so it is prefilled and
// explained. And a table with no rows rendered nothing at all, so a first run could not be told apart
// from a failure.
const workflowDetailLabels={
  en:{
    ownerHelp:'The identity that will resolve the gap. Your own identity is filled in when you sign in; replace it with the identity of another active user to assign the gap to them.',
    useMyIdentity:'Assign to myself',
    remediationNotes:'Remediation note',
    remediationNotesHelp:'Recorded in the audit chain and reproduced in the generated dossier. State what was corrected.',
    recycledContent:'Corrected recycled content (%)',
    recycledContentHelp:'Optional. Leave this empty to record the remediation without changing the stored packaging record.',
    viewEvidence:'Download document',
    emptyCatalog:'No records of this type are stored yet. Import packaging data in step 01.',
    emptyRequirements:'No evidence requirements have been derived yet. Import packaging data in step 01 first.',
    emptyEvidence:'No evidence documents have been uploaded yet.',
    emptyGaps:'No gaps are recorded. Run an assessment in step 04; if it found nothing non-compliant, there is nothing to resolve here.',
    emptyArtifacts:'No frozen review exists yet. Freeze a review snapshot, then generate the dossier.',
    emptyScanJobs:'No scan jobs are recorded for this tenant.',
    scanQueueTitle:'Scan queue',
    scanQueueHelp:'Operational state of the evidence scanning queue. A job that stopped and requires attention can be requeued here.',
    loadScanJobs:'Load scan queue',
    requeue:'Requeue',
    col_evidence_id:'Evidence document',
    col_attempts:'Attempts',
    col_last_error_code:'Last error',
    errGapOwnerInvalid:'That remediation owner is not an active user of this deployment. Use your own identity, which is filled in when you sign in, or the identity of another active user.',
    errGapOwnerRequired:'Assign an owner to this gap before recording remediation.',
    errRecycledContent:'The corrected recycled content must be a number between 0 and 100.',
    errEvidenceNotClean:'Only a document with a clean scan result may be approved.',
    errEvidenceExpired:'This document has expired and may no longer be approved. Request a current version from the supplier.',
    errScanJobNotDead:'Only a scan job that stopped and requires attention can be requeued.',
  },
  pl:{
    ownerHelp:'Tożsamość osoby, która usunie lukę. Po zalogowaniu wypełniany jest identyfikator zalogowanego użytkownika; aby przypisać lukę innej osobie, należy wpisać identyfikator innego aktywnego użytkownika.',
    useMyIdentity:'Przypisz do siebie',
    remediationNotes:'Opis działania naprawczego',
    remediationNotesHelp:'Zapisywany w łańcuchu audytowym i odtwarzany w wygenerowanej dokumentacji. Należy podać, co zostało poprawione.',
    recycledContent:'Skorygowana zawartość materiału z recyklingu (%)',
    recycledContentHelp:'Pole opcjonalne. Puste pole oznacza zapisanie działania naprawczego bez zmiany danych opakowania.',
    viewEvidence:'Pobierz dokument',
    emptyCatalog:'Nie zapisano jeszcze rekordów tego typu. Zaimportuj dane opakowań w kroku 01.',
    emptyRequirements:'Nie wyprowadzono jeszcze wymagań dowodowych. Najpierw zaimportuj dane opakowań w kroku 01.',
    emptyEvidence:'Nie przesłano jeszcze żadnych dokumentów dowodowych.',
    emptyGaps:'Nie zapisano żadnych luk. Uruchom ocenę w kroku 04; jeżeli nie wykryła niezgodności, nie ma tu nic do usunięcia.',
    emptyArtifacts:'Nie istnieje jeszcze zamrożony przegląd. Zamroź migawkę przeglądu, a następnie wygeneruj dokumentację.',
    emptyScanJobs:'Dla tej organizacji nie zapisano żadnych zadań skanowania.',
    scanQueueTitle:'Kolejka skanowania',
    scanQueueHelp:'Stan operacyjny kolejki skanowania dowodów. Zadanie, które zostało zatrzymane i wymaga uwagi, można tutaj skierować ponownie do kolejki.',
    loadScanJobs:'Wczytaj kolejkę skanowania',
    requeue:'Skieruj ponownie do kolejki',
    col_evidence_id:'Dokument dowodowy',
    col_attempts:'Liczba prób',
    col_last_error_code:'Ostatni błąd',
    errGapOwnerInvalid:'Wskazany właściciel działania naprawczego nie jest aktywnym użytkownikiem tego wdrożenia. Użyj własnego identyfikatora, wypełnianego po zalogowaniu, albo identyfikatora innego aktywnego użytkownika.',
    errGapOwnerRequired:'Przed zapisaniem działania naprawczego przypisz właściciela luki.',
    errRecycledContent:'Skorygowana zawartość materiału z recyklingu musi być liczbą z zakresu od 0 do 100.',
    errEvidenceNotClean:'Zatwierdzić można wyłącznie dokument z czystym wynikiem skanowania.',
    errEvidenceExpired:'Ten dokument wygasł i nie może już zostać zatwierdzony. Poproś dostawcę o aktualną wersję.',
    errScanJobNotDead:'Ponownie skierować do kolejki można wyłącznie zadanie skanowania, które zostało zatrzymane i wymaga uwagi.',
  },
  de:{
    ownerHelp:'Die Identität, welche die Lücke bearbeitet. Nach der Anmeldung wird die eigene Identität eingetragen; für eine Zuweisung an eine andere Person ist die Identität eines anderen aktiven Benutzers einzutragen.',
    useMyIdentity:'Mir selbst zuweisen',
    remediationNotes:'Vermerk zur Abhilfe',
    remediationNotesHelp:'Wird in der Audit-Kette gespeichert und im erzeugten Dossier wiedergegeben. Bitte angeben, was korrigiert wurde.',
    recycledContent:'Korrigierter Rezyklatanteil (%)',
    recycledContentHelp:'Optional. Ein leeres Feld erfasst die Abhilfe, ohne den gespeicherten Verpackungsdatensatz zu verändern.',
    viewEvidence:'Dokument herunterladen',
    emptyCatalog:'Zu dieser Art sind noch keine Datensätze gespeichert. Importieren Sie Verpackungsdaten in Schritt 01.',
    emptyRequirements:'Es wurden noch keine Nachweisanforderungen abgeleitet. Importieren Sie zuerst Verpackungsdaten in Schritt 01.',
    emptyEvidence:'Es wurden noch keine Nachweisdokumente hochgeladen.',
    emptyGaps:'Es sind keine Lücken erfasst. Starten Sie eine Bewertung in Schritt 04; wenn sie nichts Beanstandetes gefunden hat, ist hier nichts zu bearbeiten.',
    emptyArtifacts:'Es existiert noch keine eingefrorene Prüfung. Frieren Sie einen Review-Snapshot ein und erzeugen Sie anschließend das Dossier.',
    emptyScanJobs:'Für diese Organisation sind keine Scan-Aufträge erfasst.',
    scanQueueTitle:'Scan-Warteschlange',
    scanQueueHelp:'Betriebszustand der Warteschlange für die Nachweisprüfung. Ein Auftrag, der angehalten wurde und Aufmerksamkeit erfordert, kann hier erneut eingeplant werden.',
    loadScanJobs:'Scan-Warteschlange laden',
    requeue:'Erneut einplanen',
    col_evidence_id:'Nachweisdokument',
    col_attempts:'Versuche',
    col_last_error_code:'Letzter Fehler',
    errGapOwnerInvalid:'Der angegebene Verantwortliche ist kein aktiver Benutzer dieser Installation. Verwenden Sie die eigene Identität, die bei der Anmeldung eingetragen wird, oder die Identität eines anderen aktiven Benutzers.',
    errGapOwnerRequired:'Weisen Sie dieser Lücke einen Verantwortlichen zu, bevor Sie eine Abhilfe erfassen.',
    errRecycledContent:'Der korrigierte Rezyklatanteil muss eine Zahl zwischen 0 und 100 sein.',
    errEvidenceNotClean:'Nur ein Dokument mit einem sauberen Prüfergebnis darf freigegeben werden.',
    errEvidenceExpired:'Dieses Dokument ist abgelaufen und darf nicht mehr freigegeben werden. Fordern Sie eine aktuelle Fassung beim Lieferanten an.',
    errScanJobNotDead:'Nur ein Scan-Auftrag, der angehalten wurde und Aufmerksamkeit erfordert, kann erneut eingeplant werden.',
  },
};
for(const locale of SUPPORTED_LOCALES)Object.assign(catalogs[locale],workflowDetailLabels[locale]);

// Why a control is disabled, and why a freeze is refused.
//
// The workbench disabled twenty-seven controls and explained one condition: "Sign in to enable the
// workflow actions below". Everything else — a role that does not hold the permission, a step that has
// to come first, an operation already running — was communicated by the button simply being grey. The
// product owner reported a working button as broken because of it, twice.
//
// `lockPermission` carries `{permission}`, replaced with the same label the role and permission matrix
// renders. Nothing else is interpolated: a lock hint states a rule, never a record.
const lockLabels={
  en:{
    lockSignedOut:'Sign in to use this action.',
    lockPermission:'This role does not hold the permission this action requires ({permission}). The role and permission table above lists the roles that do.',
    lockBusy:'Another operation is running. This becomes available when it finishes.',
    lockVerifying:'The access credential is being verified.',
    lockNeedsCredentials:'Enter the email address and the password first.',
    lockNeedsToken:'Enter an access credential first.',
    lockNeedsPayload:'Paste the import payload above, or take one of the sample files listed below, before importing.',
    lockNeedsRequirement:'Load the evidence requirements above and choose the one this document answers.',
    lockNeedsFile:'Choose the evidence file to upload.',
    lockNeedsOwnerId:'Enter the identity that will resolve the gap in the field above.',
    lockNeedsGapOwner:'Assign an owner to this gap before recording remediation.',
    lockNeedsNote:'State what was corrected in the remediation note above.',
    lockNeedsSnapshot:'The dossier is generated only from a frozen review snapshot. Freeze one in this step first.',
    freezeBlockedNote:'Freezing succeeds only once no blocking gap is open. While any remain the deployment refuses it; resolve them in step 05 and freeze again.',
    errReviewBlocked:'The review was not frozen because blocking gaps are still open. Resolve them in step 05, then freeze again.',
    errReviewIncomplete:'The review was not frozen because at least one packaging record has no current assessment. Run the assessment in step 04, then freeze again.',
  },
  pl:{
    lockSignedOut:'Zaloguj się, aby wykonać to działanie.',
    lockPermission:'Ta rola nie ma uprawnienia wymaganego przez to działanie ({permission}). Tabela ról i uprawnień powyżej wskazuje role, które je posiadają.',
    lockBusy:'Trwa inna operacja. Działanie stanie się dostępne po jej zakończeniu.',
    lockVerifying:'Trwa weryfikacja danych dostępowych.',
    lockNeedsCredentials:'Najpierw podaj adres e-mail i hasło.',
    lockNeedsToken:'Najpierw podaj dane dostępowe.',
    lockNeedsPayload:'Przed importem wklej dane importu powyżej albo skorzystaj z jednego z plików przykładowych wskazanych poniżej.',
    lockNeedsRequirement:'Wczytaj wymagania dowodowe powyżej i wybierz to, którego dotyczy dokument.',
    lockNeedsFile:'Wskaż plik dowodu do przesłania.',
    lockNeedsOwnerId:'W polu powyżej podaj tożsamość osoby, która usunie lukę.',
    lockNeedsGapOwner:'Przed zapisaniem działania naprawczego przypisz właściciela tej luki.',
    lockNeedsNote:'W polu powyżej opisz, co zostało poprawione.',
    lockNeedsSnapshot:'Dokumentacja powstaje wyłącznie z zamrożonej migawki przeglądu. Najpierw zamroź migawkę w tym kroku.',
    freezeBlockedNote:'Zamrożenie powiedzie się dopiero wtedy, gdy nie pozostanie żadna luka blokująca. Dopóki takie luki istnieją, wdrożenie odmawia zamrożenia; usuń je w kroku 05 i zamroź migawkę ponownie.',
    errReviewBlocked:'Przegląd nie został zamrożony, ponieważ pozostają otwarte luki blokujące. Usuń je w kroku 05 i zamroź migawkę ponownie.',
    errReviewIncomplete:'Przegląd nie został zamrożony, ponieważ co najmniej jeden rekord opakowania nie ma aktualnej oceny. Uruchom ocenę w kroku 04 i zamroź migawkę ponownie.',
  },
  de:{
    lockSignedOut:'Melden Sie sich an, um diese Aktion auszuführen.',
    lockPermission:'Diese Rolle besitzt die für diese Aktion erforderliche Berechtigung nicht ({permission}). Die Tabelle der Rollen und Berechtigungen oben nennt die Rollen, die sie besitzen.',
    lockBusy:'Ein anderer Vorgang läuft. Die Aktion wird nach dessen Abschluss verfügbar.',
    lockVerifying:'Die Zugangsdaten werden geprüft.',
    lockNeedsCredentials:'Geben Sie zuerst die E-Mail-Adresse und das Passwort ein.',
    lockNeedsToken:'Geben Sie zuerst Zugangsdaten ein.',
    lockNeedsPayload:'Fügen Sie oben die Importdaten ein oder verwenden Sie eine der unten aufgeführten Beispieldateien, bevor Sie importieren.',
    lockNeedsRequirement:'Laden Sie oben die Nachweisanforderungen und wählen Sie diejenige aus, auf die sich das Dokument bezieht.',
    lockNeedsFile:'Wählen Sie die hochzuladende Nachweisdatei aus.',
    lockNeedsOwnerId:'Tragen Sie im Feld oben die Identität ein, welche die Lücke bearbeitet.',
    lockNeedsGapOwner:'Weisen Sie dieser Lücke einen Verantwortlichen zu, bevor Sie eine Abhilfe erfassen.',
    lockNeedsNote:'Beschreiben Sie im Feld oben, was korrigiert wurde.',
    lockNeedsSnapshot:'Das Dossier wird ausschließlich aus einem eingefrorenen Review-Snapshot erzeugt. Frieren Sie zuerst in diesem Schritt einen Snapshot ein.',
    freezeBlockedNote:'Das Einfrieren gelingt erst, wenn keine blockierende Lücke mehr offen ist. Solange welche bestehen, verweigert die Installation es; bearbeiten Sie diese in Schritt 05 und frieren Sie erneut ein.',
    errReviewBlocked:'Die Prüfung wurde nicht eingefroren, weil noch blockierende Lücken offen sind. Bearbeiten Sie diese in Schritt 05 und frieren Sie erneut ein.',
    errReviewIncomplete:'Die Prüfung wurde nicht eingefroren, weil mindestens ein Verpackungsdatensatz keine aktuelle Bewertung hat. Starten Sie die Bewertung in Schritt 04 und frieren Sie erneut ein.',
  },
};
for(const locale of SUPPORTED_LOCALES)Object.assign(catalogs[locale],lockLabels[locale]);

// Step 02, the catalog table.
//
// The catalog is the only table whose columns are chosen by the resource being inspected rather than
// written into the markup, and every one of those eight columns was missing a label: `columnLabel`
// fell back to the raw database column name with the underscores removed, so a Polish or German user
// read "packaging type", "recycled content pct" and "mass g" in the middle of otherwise translated
// headings. `packaging_type` was worse still — a closed CHECK enum whose five stored values reached
// the screen as the English words the schema stores.
//
// `family`, by contrast, is deliberately not translated as an enum: the schema places no CHECK on it,
// so its values are the operator's own material identifiers and translating them would break the
// match against the imported source data.
const catalogTableLabels={
  en:{
    col_id:'ID',col_name:'Name',col_packaging_type:'Packaging type',col_country:'Country',
    col_family:'Material family',col_recycled_content_pct:'Recycled content (%)',
    col_material_id:'Material',col_mass_g:'Mass (g)',
    val_sales:'Sales packaging',val_grouped:'Grouped packaging',val_transport:'Transport packaging',
    val_ecommerce:'E-commerce packaging',val_reusable:'Reusable packaging',
    catalogShowing:'Showing {shown} of {total} records.',
    rowsShowing:'Showing {shown} records.',
    moreRows:'Further records exist beyond those shown.',
    loadMore:'Load more records',
    // A dropdown that stops silently is worse than a long one: the requirement the user is looking for
    // is either listed or, as far as this screen says, does not exist. So when the server reports that
    // more requirements remain, the selector says so and offers to reach them.
    requirementsTruncated:'Not every evidence requirement is listed here. Load the remaining requirements if the one you need is missing.',
    loadMoreRequirements:'Load more requirements',
  },
  pl:{
    col_id:'Identyfikator',col_name:'Nazwa',col_packaging_type:'Rodzaj opakowania',col_country:'Kraj',
    col_family:'Grupa materiałowa',col_recycled_content_pct:'Zawartość materiału z recyklingu (%)',
    col_material_id:'Materiał',col_mass_g:'Masa (g)',
    val_sales:'Opakowanie jednostkowe',val_grouped:'Opakowanie zbiorcze',val_transport:'Opakowanie transportowe',
    val_ecommerce:'Opakowanie dla handlu elektronicznego',val_reusable:'Opakowanie wielokrotnego użytku',
    catalogShowing:'Wyświetlono {shown} z {total} rekordów.',
    rowsShowing:'Wyświetlono {shown} rekordów.',
    moreRows:'Poza wyświetlonymi istnieją kolejne rekordy.',
    loadMore:'Wczytaj kolejne rekordy',
    requirementsTruncated:'Nie wszystkie wymagania dowodowe są tutaj wymienione. Wczytaj pozostałe wymagania, jeżeli brakuje potrzebnego.',
    loadMoreRequirements:'Wczytaj kolejne wymagania',
  },
  de:{
    col_id:'Kennung',col_name:'Bezeichnung',col_packaging_type:'Verpackungsart',col_country:'Land',
    col_family:'Materialgruppe',col_recycled_content_pct:'Rezyklatanteil (%)',
    col_material_id:'Material',col_mass_g:'Masse (g)',
    val_sales:'Verkaufsverpackung',val_grouped:'Umverpackung',val_transport:'Transportverpackung',
    val_ecommerce:'E-Commerce-Verpackung',val_reusable:'Mehrwegverpackung',
    catalogShowing:'Angezeigt werden {shown} von {total} Datensätzen.',
    rowsShowing:'Angezeigt werden {shown} Datensätze.',
    moreRows:'Über die angezeigten hinaus existieren weitere Datensätze.',
    loadMore:'Weitere Datensätze laden',
    requirementsTruncated:'Es sind hier nicht alle Nachweisanforderungen aufgeführt. Laden Sie die übrigen Anforderungen, falls die benötigte fehlt.',
    loadMoreRequirements:'Weitere Anforderungen laden',
  },
};
for(const locale of SUPPORTED_LOCALES)Object.assign(catalogs[locale],catalogTableLabels[locale]);

// Application navigation. The workbench had a title, a language selector and nothing else: no way to
// reach the documentation, the product site or the status page, and no statement of which build the
// user was looking at.
const navLabels={
  en:{
    navPrimary:'Workflow',navProduct:'OpenPPWR',navAccount:'Account',
    navWorkspace:'Workspace',navDemoProcess:'Demonstration process',navRoles:'Roles and permissions',
    navDocs:'Documentation',navProductSite:'Product website',navStatus:'Service status',
    navSite:'OpenPPWR website',
    navBuild:'Build',navSession:'Session',navMenu:'Open menu',navClose:'Close menu',
  },
  pl:{
    navPrimary:'Proces',navProduct:'OpenPPWR',navAccount:'Konto',
    navWorkspace:'Obszar roboczy',navDemoProcess:'Proces demonstracyjny',navRoles:'Role i uprawnienia',
    navDocs:'Dokumentacja',navProductSite:'Strona produktu',navStatus:'Status usługi',
    navSite:'Witryna OpenPPWR',
    navBuild:'Build',navSession:'Sesja',navMenu:'Otwórz menu',navClose:'Zamknij menu',
  },
  de:{
    navPrimary:'Ablauf',navProduct:'OpenPPWR',navAccount:'Konto',
    navWorkspace:'Arbeitsbereich',navDemoProcess:'Demonstrationsablauf',navRoles:'Rollen und Berechtigungen',
    navDocs:'Dokumentation',navProductSite:'Produktwebsite',navStatus:'Dienststatus',
    navSite:'OpenPPWR-Website',
    navBuild:'Build',navSession:'Sitzung',navMenu:'Menü öffnen',navClose:'Menü schließen',
  },
};
for(const locale of SUPPORTED_LOCALES)Object.assign(catalogs[locale],navLabels[locale]);

// Localizes a column name or enum value, falling back to the raw value only when no translation
// exists — which the i18n gate treats as a defect rather than an acceptable outcome.
export function columnLabel(locale,column){const key=`col_${column}`;const value=translate(locale,key);return value===key?column.replaceAll('_',' '):value;}
export function enumLabel(locale,value){if(value===null||value===undefined||value==='')return '—';const key=`val_${String(value).toLowerCase()}`;const label=translate(locale,key);return label===key?String(value):label;}

export function normalizeLocale(value){const locale=String(value||'').toLowerCase().split('-')[0];return SUPPORTED_LOCALES.includes(locale)?locale:DEFAULT_LOCALE;}
export function translate(locale,key){const normalized=normalizeLocale(locale);return catalogs[normalized][key]??catalogLabels[normalized][key]??catalogs[DEFAULT_LOCALE][key]??catalogLabels[DEFAULT_LOCALE][key]??key;}
