import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialData, identity, location, validateData } from '../core/domain';
import { Store } from '../core/persistence';

test('full path, namespace and explicit case rules define identity', () => {
  const e = initialData().environments[0];
  assert.notEqual(identity(e, '/a/repo'), identity(e, '/b/repo'));
  assert.notEqual(identity(e, '/a/repo'), identity({...e, id:'remote'}, '/a/repo'));
  assert.notEqual(identity(e, '/a/Repo'), identity(e, '/a/repo'));
  assert.equal(identity({...e, caseSensitive:false}, '/a/Repo'), identity({...e, caseSensitive:false}, '/a/repo'));
  assert.equal(identity(e, '/a/../b/repo/'), identity(e, '/b/repo'));
});
test('atomic store export/import preserves workset and environment identity', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workscene-store-')); t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const store = new Store(dir); const l = location(store.data.environments[0], '/a/repo', 'manual');
  store.data.manualLocations.push(l); store.data.worksets.push({id:'w',name:'Ship',locationIds:[l.id]}); store.save();
  assert.deepEqual(new Store(dir).data, store.data);
  const exported = store.export(); store.import(exported);
  assert.deepEqual(store.data, exported);
  assert.ok(fs.existsSync(path.join(dir, 'organization.before-import.json')));
  assert.throws(() => store.import({...exported, version:99}));
  assert.deepEqual(store.data, exported);
  assert.equal(fs.statSync(path.join(dir, 'organization.json')).mode & 0o777, 0o600);
});
test('invalid and cross-environment alias references are rejected', () => {
  const data = initialData();
  data.worksets.push({id:'x',name:'Invalid',locationIds:['missing']});
  assert.throws(() => validateData(data));
});
