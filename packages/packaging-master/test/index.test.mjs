import test from 'node:test';import assert from 'node:assert/strict';import {convert,massBalance,canApprove,compareVersions} from '../src/index.mjs';
test('unit conversion and mass balance are deterministic',()=>{assert.equal(convert(1,'kg','g'),1000);assert.equal(massBalance([{quantity:2,massPerUnit:3,materialFamily:'plastic'}]).totalMass,6);});
test('synthetic approval denied and versions compare',()=>{assert.equal(canApprove({status:'in_review',dataClassification:'SYNTHETIC'}),false);assert.equal(compareVersions({lines:[]},{lines:[{componentCode:'C1'}]}).length,1);});
