import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, requestLocale } from '../src/error-messages.mjs';

test('normalizes supported locales and falls back to English',()=>{
  assert.equal(requestLocale('pl-PL,pl;q=0.9'),'pl');
  assert.equal(requestLocale('de-DE'),'de');
  assert.equal(requestLocale('fr-FR'),'en');
});

test('localizes stable error codes without translating codes',()=>{
  assert.equal(errorMessage('pl','AUTHENTICATION_REQUIRED'),'Wymagane jest uwierzytelnienie.');
  assert.equal(errorMessage('de','RESOURCE_NOT_FOUND'),'Ressource nicht gefunden.');
  assert.equal(errorMessage('en','CUSTOM_CODE','Stable fallback.'),'Stable fallback.');
});
