import test from 'node:test';
import assert from 'node:assert/strict';
import { correlationId } from '../src/index.mjs';
test('invalid correlation ID is replaced', () => { const req={get:()=>'<bad>'}; const headers={}; const res={set:(k,v)=>{headers[k]=v;return res;}}; correlationId(req,res,()=>{}); assert.match(req.correlationId,/^[0-9a-f-]{36}$/); });
