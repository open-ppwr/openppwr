// Why a control is disabled — one mechanism, so that a disabled control cannot exist without a reason.
//
// The workbench rendered twenty-seven `disabled=` expressions and one explanation, and that explanation
// covered only "not signed in". A greyed-out button was therefore indistinguishable from a broken one.
// It cost two incidents: the product owner, signed in as a compliance manager, reported "Generate
// dossier" as broken — the role does hold `dossier:generate`, and the button was waiting for the freeze
// in step 06 — and the freeze that would have unlocked it would itself have been refused with 409 while
// blocking gaps remained. Both are correct product behaviour. Neither was discoverable from the screen.
//
// This lives in a module of its own rather than in `App.jsx`, and that is not tidiness. `App.jsx` imports
// `AppNav.jsx`, so a component exported from `App.jsx` cannot be used by the navigation without an import
// cycle — and the navigation carries a workflow control too. Left where it was, exactly one control in
// the product was disabled with no reason attached, and the guard that forbids that was scoped to the
// file it happened not to be in. Both files now read this declaration, and
// `test/disabled-reasons.test.mjs` reads both of them.

// Precedence, deliberately, most permanent first:
//
//   1. signed out   — nothing else can even be evaluated. `can()` reads `identity.permissions`, so while
//                     nobody is signed in *every* permission test is false; were the permission reason to
//                     outrank this one, a visitor with no role at all would be told that their role lacks
//                     thirteen permissions.
//   2. permission   — terminal for this session, and it outranks the step-order reason on purpose.
//                     Telling a read-only auditor to "freeze a snapshot first" sends them to a second
//                     control they also may not press; what they need to know is that no order of steps
//                     will help. This is a deliberate departure from the more obvious "steps before
//                     roles" ordering, and the auditor is the case that decides it.
//   3. precondition — the step or the field that has to come first. Actionable here and now, which is
//                     why it must not be hidden behind a reason the user cannot act on.
//   4. busy         — transient, and therefore last: while an operation runs, the deeper reason a control
//                     is locked is still the deeper reason, and a hint that flickers between two truths
//                     teaches the reader to ignore it.
export function lockOf({signedOut=false,permission=null,precondition=null,busy=false}={}){
  if(signedOut)return {key:'lockSignedOut'};
  if(permission)return {key:'lockPermission',permission};
  if(precondition)return {key:precondition};
  if(busy)return {key:'lockBusy'};
  return null;
}

// The reason, in the reader's language. Every message is a catalog string; the only value ever
// interpolated is the permission label, which comes from the public registry. Nothing about a
// particular record can reach this text — see the note on `Locked`.
export function lockMessage(t,lock){
  if(!lock)return null;
  return lock.permission?t('lockPermission').replace('{permission}',lock.permission):t(lock.key);
}

// The only control in this product that is ever `disabled`. Every gated control states its lock and
// renders through here, so the explanation is attached to the control by construction rather than by
// discipline: visible beside it, repeated in `title`, and referenced by `aria-describedby` so a screen
// reader announces it with the control instead of reaching a silent dead button.
//
// It deliberately cannot leak object existence. The three things it can say are "you are not signed in",
// "this role does not hold this permission" — the registry is unauthenticated at `/v1/permissions` and
// the role matrix renders all of it — and "this step comes first". None of them states whether a
// particular record exists, which is the distinction `requirePermission` protects by answering 404
// rather than 403.
export function Locked({t,id,lock,className,children,onClick}){
  const reason=lockMessage(t,lock);
  const hintId=`${id}-lock`;
  return <span className="lock">
    <button data-testid={id} className={className} disabled={Boolean(reason)} onClick={onClick}
      title={reason||undefined} aria-describedby={reason?hintId:undefined}>{children}</button>
    {reason&&<span className="lock-reason" id={hintId} data-testid={hintId}>{reason}</span>}
  </span>;
}
