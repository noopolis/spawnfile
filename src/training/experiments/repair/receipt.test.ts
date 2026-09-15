import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { readMeasurementRepair, repairDigest } from './receipt.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(),'repair-receipt-'))); roots.push(root);
  const parent = join(root,'parent'); await mkdir(parent);
  const sha = repairDigest('bytes');
  const receipt = {version:'paideia.measurement-repair.v1',
    parent:{root:parent,imageId:sha,experimentId:'original',executionIdentity:'original-execution',manifestDigest:sha,
      checkpoints:{command:sha,training:sha,host:sha,optimizer:sha},trainingIdentity:'original-training'},
    current:{imageId:sha,canonicalSourceDigest:sha,adapterId:'daimon-native'},
    compatibility:{version:'spawnfile.daimon-dspy-compatibility.v1',digest:'',components:{native:sha},inputs:{evidence:sha}}};
  const path = join(root,'receipt.json');
  const save = async () => {
    receipt.compatibility.digest = repairDigest(JSON.stringify({components:receipt.compatibility.components,inputs:receipt.compatibility.inputs}));
    const envelope = {receipt,digest:repairDigest(JSON.stringify(receipt))}; await writeFile(path,JSON.stringify(envelope)); return envelope;
  };
  const expected = {parentRoot:parent,out:join(root,'child'),imageId:sha,adapterId:'daimon-native',canonicalSourceDigest:sha};
  return {root,path,receipt,expected,save,envelope:await save()};
}
it('accepts exact protected handoff and hashes exact UTF-8 bytes',async()=>{
  const f=await fixture(); expect(await readMeasurementRepair(f.path,f.expected)).toEqual(f.envelope);
  expect(repairDigest('é')).toBe(repairDigest(Buffer.from('é')));
});
it.each(['envelope','compatibility','extra','malformed','oversize'])('rejects %s corruption before authority is accepted',async kind=>{
  const f=await fixture();
  if(kind==='envelope') f.envelope.digest=repairDigest('wrong');
  if(kind==='compatibility') {f.envelope.receipt.compatibility.digest=repairDigest('wrong');f.envelope.digest=repairDigest(JSON.stringify(f.receipt));}
  if(kind==='extra') Object.assign(f.envelope.receipt,{undeclared:true});
  await writeFile(f.path,kind==='malformed'?'{broken':kind==='oversize'?' '.repeat(1048577):JSON.stringify(f.envelope));
  await expect(readMeasurementRepair(f.path,f.expected)).rejects.toThrow();
});
it.each(['image','adapter','source','missing-image','missing-source','components','inputs'])('rejects missing or mismatched %s authority',async kind=>{
  const f=await fixture();
  if(kind==='image')f.expected.imageId=repairDigest('other');
  if(kind==='adapter')f.expected.adapterId='foreign';
  if(kind==='source')f.expected.canonicalSourceDigest=repairDigest('other');
  if(kind==='missing-image')Object.assign(f.expected,{imageId:undefined});
  if(kind==='missing-source')Object.assign(f.expected,{canonicalSourceDigest:undefined});
  if(kind==='components')Object.assign(f.receipt.compatibility,{components:{}});
  if(kind==='inputs')Object.assign(f.receipt.compatibility,{inputs:{}});
  await f.save(); await expect(readMeasurementRepair(f.path,f.expected)).rejects.toThrow(/authority|evidence/);
});
it.each(['relative','file-link','parent-link','wrong-parent','same-output','nested-output','ancestor-output','directory'])('rejects unsafe %s paths',async kind=>{
  const f=await fixture(); let path=f.path;
  if(kind==='relative')path='receipt.json';
  if(kind==='file-link'){path=join(f.root,'link');await symlink(f.path,path);}
  if(kind==='parent-link'){const link=join(f.root,'parent-link');await symlink(f.expected.parentRoot,link);f.expected.parentRoot=link;f.receipt.parent.root=link;await f.save();}
  if(kind==='wrong-parent')f.expected.parentRoot=join(f.root,'other');
  if(kind==='same-output')f.expected.out=f.expected.parentRoot;
  if(kind==='nested-output')f.expected.out=join(f.expected.parentRoot,'child');
  if(kind==='ancestor-output')f.expected.out=f.root;
  if(kind==='directory')path=f.root;
  await expect(readMeasurementRepair(path,f.expected)).rejects.toThrow();
});
it('rejects a FIFO receipt without blocking on its writer',async()=>{
  const f=await fixture(), fifo=join(f.root,'fifo');await promisify(execFile)('mkfifo',[fifo]);
  const module = new URL('./receipt.ts',import.meta.url).pathname;
  const program=`const {readMeasurementRepair}=await import(${JSON.stringify(module)});try{await readMeasurementRepair(${JSON.stringify(fifo)},${JSON.stringify(f.expected)});process.exitCode=1;}catch(e){if(!/regular|file|Unsafe/i.test(e.message))throw e;console.log('REJECTED_FIFO');}`;
  const result=await promisify(execFile)(process.execPath,['--experimental-strip-types','--input-type=module','-e',program],{timeout:3000});
  expect(result.stdout).toContain('REJECTED_FIFO');
});
