import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openJudgeCache } from './index.js';
import { contentDigest } from '../content.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paideia-cache-')); roots.push(root);
  return {root, namespace:'calibration-v1', maxEntries:2, maxBytes:4096};
}
const value = {
  response: JSON.stringify({score:0.7,verdict:'fail',reasons:['Needs clarity'],citations:[{source:'input',quote:'article'}]}),
  sourceCallId:'source', sourceCalls:[{id:'source',judge:'clarity',providerId:'subscription',requestedModel:'small',
    responseModel:'actual-small',responseRoute:'subscription',outcome:'completed' as const,usage:null}],
};
const key = contentDigest('request');
const modulePath = fileURLToPath(new URL('./index.ts', import.meta.url));
const child = promisify(execFile);

it('persists a failed quality grade and original model provenance across an actual process restart', async () => {
  const options = await fixture();
  const cache = await openJudgeCache(options);
  await cache.put(key,value);
  const result = await child(process.execPath, ['--import','tsx','--input-type=module','-e',
    `import {openJudgeCache} from ${JSON.stringify(modulePath)}; const cache=await openJudgeCache(${JSON.stringify(options)}); console.log(JSON.stringify(await cache.get(${JSON.stringify(key)})));`],
  {cwd:fileURLToPath(new URL('../../..',import.meta.url))});
  expect(JSON.parse(result.stdout)).toEqual(value);
  const hit = await cache.get(key); hit!.sourceCalls![0]!.responseModel = 'mutated';
  expect(await cache.get(key)).toEqual(value);
  expect(await (await openJudgeCache({...options,namespace:'calibration-v2'})).get(key)).toBeUndefined();
});

it('serializes independent process writes with first-result provenance and bounded eviction', async () => {
  const options = {...await fixture(),maxEntries:3};
  await openJudgeCache(options);
  const results = await Promise.all(Array.from({length:4},(_,index) => child(process.execPath,
    ['--import','tsx','--input-type=module','-e',`import {openJudgeCache} from ${JSON.stringify(modulePath)};
    const cache=await openJudgeCache(${JSON.stringify(options)}); await cache.put(${JSON.stringify(contentDigest(String(index)))},${JSON.stringify(value)}); console.log('written');`],
    {cwd:fileURLToPath(new URL('../../..',import.meta.url))})));
  expect(results.every(result=>result.stdout.trim()==='written')).toBe(true);
  const cache = await openJudgeCache(options);
  expect((await Promise.all(Array.from({length:4},(_,i)=>cache.get(contentDigest(String(i)))))).filter(Boolean)).toHaveLength(3);
  await cache.put(key,value);
  await cache.put(key,{...value,response:value.response.replace('0.7','0.9').replace('"fail"','"pass"')});
  expect(await cache.get(key)).toEqual(value);
});

it('recovers a killed SQLite transaction without a stale application lock or changed judgment', async () => {
  const options = await fixture(); const cache = await openJudgeCache(options); await cache.put(key,value);
  const path = join(options.root,(await readdir(options.root)).find(name=>name.endsWith('.sqlite'))!);
  const processChild = spawn(process.execPath,['--input-type=module','-e',
    `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(path)});
    db.exec("BEGIN IMMEDIATE; DELETE FROM judgments"); console.log('transaction-open'); setInterval(()=>{},1000);`],
  {stdio:['ignore','pipe','pipe']});
  const terminated = new Promise(resolve=>processChild.once('close',resolve));
  try {
    await new Promise<void>((resolve,reject)=>{
      const timeout = setTimeout(()=>reject(new Error('Child transaction did not open')),3000);
      processChild.stdout.once('data',chunk=>{clearTimeout(timeout);expect(String(chunk)).toContain('transaction-open');resolve();});
      processChild.once('error',error=>{clearTimeout(timeout);reject(error);});
    });
  } finally {processChild.kill('SIGKILL');await terminated;}
  const restarted = await openJudgeCache(options);
  expect(await restarted.get(key)).toEqual(value);
  await restarted.put(contentDigest('after-crash'),value);
  expect(await restarted.get(contentDigest('after-crash'))).toEqual(value);
});

it('evicts by entry and byte bounds, refuses oversized entries and unsafe keys', async () => {
  const options = await fixture();
  const cache = await openJudgeCache({...options,maxBytes:900});
  await cache.put(key,value); await cache.put(contentDigest('second'),value);
  expect(await cache.get(key)).toBeUndefined();
  expect(await cache.get(contentDigest('second'))).toEqual(value);
  const tiny = await openJudgeCache({...options,namespace:'tiny',maxBytes:1});
  await tiny.put(key,value); expect(await tiny.get(key)).toBeUndefined();
  await expect(cache.get('../bad')).rejects.toThrow('digest');
  await expect(cache.put('not-a-digest',value)).rejects.toThrow('digest');
  await cache.put(contentDigest('third'),value);
  const shrunk = await openJudgeCache({...options,maxEntries:1,maxBytes:1});
  expect(await shrunk.get(contentDigest('third'))).toBeUndefined();
});

it('rejects tampered rows, forged scope and invalid provenance rather than treating them as cache misses', async () => {
  const options = await fixture(); const cache = await openJudgeCache(options); await cache.put(key,value);
  const path = join(options.root,(await readdir(options.root)).find(name=>name.endsWith('.sqlite'))!);
  const db = new DatabaseSync(path);
  try {
    const original = db.prepare('SELECT body FROM judgments WHERE key=?').get(key)!.body as string;
    db.prepare('UPDATE judgments SET digest=?').run(contentDigest('tampered'));
    await expect(cache.get(key)).rejects.toThrow('integrity');
    await expect(cache.put(key,value)).rejects.toThrow('integrity');
    const body = original.replace('calibration-v1','calibration-v0');
    db.prepare('UPDATE judgments SET body=?,digest=?,bytes=?').run(body,contentDigest(body),Buffer.byteLength(body));
    await expect(cache.get(key)).rejects.toThrow('scope');
    db.prepare('UPDATE judgments SET body=?,digest=?,bytes=?').run('{',contentDigest('{'),1);
    await expect(cache.get(key)).rejects.toThrow('envelope');
    const invalid = JSON.stringify({...JSON.parse(original),value:{...value,sourceCallId:'forged'}});
    db.prepare('UPDATE judgments SET body=?,digest=?,bytes=?').run(invalid,contentDigest(invalid),Buffer.byteLength(invalid));
    await expect(cache.get(key)).rejects.toThrow('completed inference');
  } finally {db.close();}
});

it('rejects unsafe filesystem state and invalid bounds', async () => {
  const options = await fixture();
  for (const update of [{namespace:''},{namespace:'x'.repeat(513)},{maxEntries:0},{maxEntries:10001},{maxBytes:0},{maxBytes:33554433},{maxBytes:1.5}]) {
    await expect(openJudgeCache({...options,...update})).rejects.toThrow('Invalid');
  }
  await openJudgeCache(options);
  const path = join(options.root,(await readdir(options.root)).find(name=>name.endsWith('.sqlite'))!);
  await chmod(path,0o644); await expect(openJudgeCache(options)).rejects.toThrow('private');
  await rm(path); await symlink('/dev/null',path); await expect(openJudgeCache(options)).rejects.toThrow('symlink');
  await rm(path); await writeFile(path,'not a database',{mode:0o600});
  await expect(openJudgeCache(options)).rejects.toThrow();
  const cache = await openJudgeCache({...options,namespace:'other'});
  await expect(cache.put(key,{...value,sourceCalls:undefined})).rejects.toThrow('provenance');
});

it('enforces byte eviction even when stored accounting columns are corrupted', async () => {
  const options = await fixture(); const cache = await openJudgeCache(options);
  await cache.put(key,value); await cache.put(contentDigest('second'),value);
  const path = join(options.root,(await readdir(options.root)).find(name=>name.endsWith('.sqlite'))!);
  const db = new DatabaseSync(path);
  try {
    db.exec('UPDATE judgments SET bytes=1');
    const limited = await openJudgeCache({...options,maxBytes:900});
    expect(db.prepare('SELECT count(*) AS count FROM judgments').get()!.count).toBe(1);
    expect(await limited.get(key)).toBeUndefined();
    await expect(limited.get(contentDigest('second'))).rejects.toThrow('integrity');
  } finally {db.close();}
});

it('does not charge evicted oversized rows against the capacity of remaining valid entries', async () => {
  const options = await fixture(); const cache = await openJudgeCache(options);
  await cache.put(key,value); await cache.put(contentDigest('newest'),value);
  const path = join(options.root,(await readdir(options.root)).find(name=>name.endsWith('.sqlite'))!);
  const db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE judgments SET body=? WHERE key=?').run('damaged'.repeat(1000),contentDigest('newest'));
    const limited = await openJudgeCache({...options,maxBytes:900});
    expect(await limited.get(contentDigest('newest'))).toBeUndefined();
    expect(await limited.get(key)).toEqual(value);
  } finally {db.close();}
});


it('reopens evidence-ID grades in another process and preserves first-write provenance', async () => {
  const options = await fixture();
  const cache = await openJudgeCache(options);
  const evidence = { ...value, response: JSON.stringify({ score: 0.84, verdict: 'fail',
    reasons: ['The quantity is supported; attribution is weak.'], evidenceIds: ['e-0123456789abcdef0123'] }) };
  await cache.put(key, evidence);
  await cache.put(key, { ...evidence, response: evidence.response.replace('0.84', '0.95') });
  const reopened = await child(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import {openJudgeCache} from ${JSON.stringify(modulePath)}; const cache=await openJudgeCache(${JSON.stringify(options)}); console.log(JSON.stringify(await cache.get(${JSON.stringify(key)})));`],
  { cwd: fileURLToPath(new URL('../../..', import.meta.url)) });
  expect(JSON.parse(reopened.stdout)).toEqual(evidence);
  const invalidKey = contentDigest('invalid-evidence');
  await expect(cache.put(invalidKey, { ...evidence, response: evidence.response.replace('e-0123456789abcdef0123', 'unknown') }))
    .rejects.toThrow('response');
  expect(await cache.get(invalidKey)).toBeUndefined();
  await expect(cache.put(invalidKey, { ...evidence, sourceCalls: [{ ...value.sourceCalls[0]!, outcome: 'generation-error' }] }))
    .rejects.toThrow('completed inference');
  expect(await cache.get(invalidKey)).toBeUndefined();
  expect(await (await openJudgeCache({ ...options, namespace: 'different-calibration' })).get(key)).toBeUndefined();
  const path = join(options.root, `${contentDigest(options.namespace).slice(7)}.sqlite`);
  const db = new DatabaseSync(path);
  try {
    // Recomputed envelope digest cannot make structurally corrupt evidence valid.
    const stored = JSON.parse(db.prepare('SELECT body FROM judgments WHERE key=?').get(key)!.body as string);
    stored.value.response = evidence.response.replace('e-0123456789abcdef0123', 'unknown');
    const body = JSON.stringify(stored);
    db.prepare('UPDATE judgments SET body=?,digest=?,bytes=? WHERE key=?')
      .run(body, contentDigest(body), Buffer.byteLength(body), key);
    await expect(cache.get(key)).rejects.toThrow('response');
  } finally { db.close(); }
});
