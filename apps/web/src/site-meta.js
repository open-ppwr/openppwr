// Per-route, per-locale SEO metadata. The site is a client-rendered SPA, so head tags are
// applied at runtime; canonical and hreflang alternates are emitted for every locale.
import { canonicalOrigin } from './runtime.js';

// The marketing site's own origin, not whichever host happened to serve the document.
//
// Deriving this from window.location.origin meant every hostname that served the page declared itself
// canonical for it, so six hosts published six canonical URLs for one piece of content. On a
// single-host deployment there is only one origin and the two are the same value.
export const SITE_ORIGIN=canonicalOrigin('marketing');
const LOCALES=['en','pl','de'];

const meta={
  en:{
    home:{t:'OpenPPWR — reproducible packaging readiness',d:'Self-hosted, Apache-2.0 packaging compliance workflow: import, supplier evidence, versioned assessment, remediation and a verifiable dossier.'},
    product:{t:'Product — one evidence chain',d:'From packaging records to review-ready evidence, with exact rule versions and a reproducible dossier.'},
    community:{t:'Community — Apache-2.0 self-hosted core',d:'The complete packaging readiness workflow, self-hosted and free under Apache-2.0.'},
    enterprise:{t:'Enterprise — planned identity and governance controls',d:'SSO, SCIM, advanced RBAC, SIEM export and private deployment. All planned, none available yet.'},
    cloud:{t:'Cloud — managed OpenPPWR, Private Beta',d:'Managed deployment and operation of the OpenPPWR workflow. Private Beta with manual onboarding.'},
    connect:{t:'Connect — SAP and ERP integration',d:'Commercial SAP and ERP integration modules. Planned; no production connector exists yet.'},
    regulatory:{t:'Regulatory — maintained rule packs',d:'Versioned regulatory rule packs with named human review. Gated on qualified regulatory review.'},
    services:{t:'Services — assessment, QuickStart and delivery',d:'Readiness assessment, installation, migration, integration design, training and Design Partner work.'},
    pricing:{t:'Pricing — Community is free, the rest is contact sales',d:'Community is free under Apache-2.0. No prices are published for Cloud, Connect, Regulatory, Enterprise or Services.'},
    demo:{t:'Demo — fictional ACME dataset, real workflow',d:'A guided end-to-end demonstration on fictional ACME data: import, evidence, assessment, remediation and dossier.'},
    docs:{t:'Documentation — install, verify, recover',d:'QuickStart, installer, backup and restore, upgrade and rollback, API, architecture and known limitations.'},
    roadmap:{t:'Roadmap — Now, Next, Later',d:'Sequence and status without dates. Community completeness first, commercial capability after real adoption.'},
    security:{t:'Security — controls, evidence and what we do not claim',d:'Tenant isolation, fail-closed malware scanning, audit integrity, rate limiting and web security controls. No certification claimed.'},
    trust:{t:'Trust — evidence over promises',d:'Data ownership, isolation, encryption, recovery, release assurance, and an explicit list of what is not independently verified.'},
    partners:{t:'Partners — Design Partner program',d:'One program, open now: Design Partner. Other partner types are not offered yet.'},
    privacy:{t:'Privacy notice',d:'What we process, why, and what we do not. A self-hosted Community deployment sends us nothing at all.'},
    terms:{t:'Terms of use — not published yet',d:'This page is being prepared and has not been approved for publication.'},
    cookies:{t:'Cookie notice',d:'No analytics and no tracking. Strictly necessary cookies only, disclosed in full.'},
    imprint:{t:'Company information',d:'Legal entity, registered address, register and contact details for OpenPPWR.'},
  },
  pl:{
    home:{t:'OpenPPWR — odtwarzalna gotowość opakowań',d:'Self-hosted proces zgodności opakowań na Apache-2.0: import, dowody dostawców, wersjonowana ocena, działania naprawcze i weryfikowalna dokumentacja.'},
    product:{t:'Produkt — jeden łańcuch dowodowy',d:'Od danych opakowań do materiału gotowego do przeglądu, z dokładnymi wersjami reguł i odtwarzalną dokumentacją.'},
    community:{t:'Community — rdzeń self-hosted na Apache-2.0',d:'Kompletny proces gotowości opakowaniowej, self-hosted i bezpłatny na licencji Apache-2.0.'},
    enterprise:{t:'Enterprise — planowane kontrole tożsamości i governance',d:'SSO, SCIM, zaawansowany RBAC, eksport do SIEM i wdrożenie prywatne. Wszystko planowane, nic jeszcze niedostępne.'},
    cloud:{t:'Cloud — zarządzany OpenPPWR, Private Beta',d:'Zarządzane wdrożenie i utrzymanie procesu OpenPPWR. Private Beta z ręcznym onboardingiem.'},
    connect:{t:'Connect — integracja z SAP i ERP',d:'Komercyjne moduły integracji SAP i ERP. Planowane; produkcyjny konektor jeszcze nie istnieje.'},
    regulatory:{t:'Regulatory — utrzymywane pakiety reguł',d:'Wersjonowane pakiety reguł z imiennym przeglądem człowieka. Zależne od kwalifikowanego przeglądu regulacyjnego.'},
    services:{t:'Usługi — ocena, QuickStart i wdrożenie',d:'Ocena gotowości, instalacja, migracja, projekt integracji, szkolenia i współpraca Design Partner.'},
    pricing:{t:'Cennik — Community bezpłatnie, reszta na zapytanie',d:'Community jest bezpłatne na Apache-2.0. Nie publikujemy cen dla Cloud, Connect, Regulatory, Enterprise ani usług.'},
    demo:{t:'Demo — fikcyjne dane ACME, prawdziwy proces',d:'Prowadzona demonstracja end-to-end na fikcyjnych danych ACME: import, dowody, ocena, działania naprawcze i dokumentacja.'},
    docs:{t:'Dokumentacja — instaluj, weryfikuj, odtwarzaj',d:'QuickStart, instalator, backup i restore, upgrade i rollback, API, architektura i znane ograniczenia.'},
    roadmap:{t:'Roadmap — Teraz, Następnie, Później',d:'Kolejność i status bez dat. Najpierw kompletność Community, możliwości komercyjne po realnej adopcji.'},
    security:{t:'Bezpieczeństwo — kontrole, dowody i czego nie deklarujemy',d:'Izolacja tenantów, fail-closed skanowanie malware, integralność audytu, limity żądań i kontrole webowe. Bez deklaracji certyfikacji.'},
    trust:{t:'Zaufanie — dowody zamiast obietnic',d:'Własność danych, izolacja, szyfrowanie, odtwarzanie, zapewnienie wydania i jawna lista rzeczy niezweryfikowanych niezależnie.'},
    partners:{t:'Partnerzy — program Design Partner',d:'Jeden program, otwarty teraz: Design Partner. Pozostałe typy partnerstwa nie są jeszcze oferowane.'},
    privacy:{t:'Informacja o prywatności',d:'Co przetwarzamy, w jakim celu i czego nie robimy. Wdrożenie self-hosted Community nie wysyła nam niczego.'},
    terms:{t:'Warunki korzystania — jeszcze nieopublikowane',d:'Ta strona jest przygotowywana i nie została zatwierdzona do publikacji.'},
    cookies:{t:'Informacja o cookies',d:'Brak analityki i śledzenia. Wyłącznie ciasteczka ściśle niezbędne, ujawnione w całości.'},
    imprint:{t:'Informacje o firmie',d:'Podmiot prawny, adres siedziby, rejestr i dane kontaktowe OpenPPWR.'},
  },
  de:{
    home:{t:'OpenPPWR — reproduzierbare Verpackungsbereitschaft',d:'Selbst gehosteter Verpackungs-Compliance-Ablauf unter Apache-2.0: Import, Lieferantennachweise, versionierte Bewertung, Abhilfe und verifizierbares Dossier.'},
    product:{t:'Produkt — eine Nachweiskette',d:'Von Verpackungsdaten zum prüfbereiten Stand, mit exakten Regelversionen und reproduzierbarem Dossier.'},
    community:{t:'Community — selbst gehosteter Kern unter Apache-2.0',d:'Der vollständige Ablauf zur Verpackungsbereitschaft, selbst gehostet und kostenlos unter Apache-2.0.'},
    enterprise:{t:'Enterprise — geplante Identitäts- und Governance-Kontrollen',d:'SSO, SCIM, erweitertes RBAC, SIEM-Export und privates Deployment. Alles geplant, nichts bereits verfügbar.'},
    cloud:{t:'Cloud — verwaltetes OpenPPWR, Private Beta',d:'Verwaltetes Deployment und Betrieb des OpenPPWR-Ablaufs. Private Beta mit manuellem Onboarding.'},
    connect:{t:'Connect — SAP- und ERP-Integration',d:'Kommerzielle SAP- und ERP-Integrationsmodule. Geplant; ein produktiver Connector existiert noch nicht.'},
    regulatory:{t:'Regulatory — gepflegte Regelpakete',d:'Versionierte regulatorische Regelpakete mit namentlicher menschlicher Prüfung. Abhängig von qualifizierter regulatorischer Prüfung.'},
    services:{t:'Services — Assessment, QuickStart und Umsetzung',d:'Readiness Assessment, Installation, Migration, Integrationsdesign, Schulung und Design-Partner-Arbeit.'},
    pricing:{t:'Preise — Community kostenlos, alles Weitere auf Anfrage',d:'Community ist kostenlos unter Apache-2.0. Für Cloud, Connect, Regulatory, Enterprise und Services werden keine Preise veröffentlicht.'},
    demo:{t:'Demo — fiktive ACME-Daten, echter Ablauf',d:'Eine geführte End-to-End-Demonstration mit fiktiven ACME-Daten: Import, Nachweise, Bewertung, Abhilfe und Dossier.'},
    docs:{t:'Dokumentation — installieren, prüfen, wiederherstellen',d:'QuickStart, Installer, Backup und Restore, Upgrade und Rollback, API, Architektur und bekannte Einschränkungen.'},
    roadmap:{t:'Roadmap — Jetzt, Als Nächstes, Später',d:'Reihenfolge und Status ohne Termine. Zuerst Vollständigkeit von Community, kommerzielle Fähigkeiten nach echter Nutzung.'},
    security:{t:'Sicherheit — Kontrollen, Nachweise und was wir nicht behaupten',d:'Tenant-Isolation, Fail-closed-Malware-Prüfung, Audit-Integrität, Ratenbegrenzung und Web-Sicherheitskontrollen. Keine Zertifizierung behauptet.'},
    trust:{t:'Trust — Nachweise statt Versprechen',d:'Datenhoheit, Isolation, Verschlüsselung, Wiederherstellung, Release-Sicherung und eine ausdrückliche Liste nicht unabhängig verifizierter Punkte.'},
    partners:{t:'Partner — Design-Partner-Programm',d:'Ein Programm, jetzt offen: Design Partner. Andere Partnertypen werden noch nicht angeboten.'},
    privacy:{t:'Datenschutzhinweis',d:'Was wir verarbeiten, warum, und was nicht. Eine selbst gehostete Community-Installation sendet uns überhaupt nichts.'},
    terms:{t:'Nutzungsbedingungen — noch nicht veröffentlicht',d:'Diese Seite wird vorbereitet und ist noch nicht zur Veröffentlichung freigegeben.'},
    cookies:{t:'Cookie-Hinweis',d:'Keine Analytik und kein Tracking. Ausschließlich unbedingt erforderliche Cookies, vollständig offengelegt.'},
    imprint:{t:'Unternehmensangaben',d:'Rechtsträger, Anschrift, Register und Kontaktdaten für OpenPPWR.'},
  },
};

export function metaFor(locale,route){
  const normalized=LOCALES.includes(locale)?locale:'en';
  return meta[normalized][route]??meta[normalized].home??meta.en.home;
}

function upsertMeta(name,content){
  let element=document.head.querySelector(`meta[name="${name}"]`);
  if(!element){element=document.createElement('meta');element.setAttribute('name',name);document.head.appendChild(element);}
  element.setAttribute('content',content);
}

function upsertLink(rel,href,hreflang){
  const selector=hreflang?`link[rel="${rel}"][hreflang="${hreflang}"]`:`link[rel="${rel}"]:not([hreflang])`;
  let element=document.head.querySelector(selector);
  if(!element){element=document.createElement('link');element.setAttribute('rel',rel);if(hreflang)element.setAttribute('hreflang',hreflang);document.head.appendChild(element);}
  element.setAttribute('href',href);
}

export function applyDocumentMeta(locale,route){
  if(typeof document==='undefined')return;
  const {t,d}=metaFor(locale,route);
  document.title=t;
  document.documentElement.lang=locale;
  upsertMeta('description',d);
  const path=(target)=>`${SITE_ORIGIN}/${target}${route==='home'?'':`/${route}`}`;
  upsertLink('canonical',path(locale));
  for(const alternate of LOCALES)upsertLink('alternate',path(alternate),alternate);
  upsertLink('alternate',path('en'),'x-default');
}
