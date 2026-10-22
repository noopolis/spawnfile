import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyRepairProjection } from './projection.js';
import { repairDigest, type MeasurementRepairReceipt } from './receipt.js';

const reads=vi.hoisted(()=>({forbidden:''}));
vi.mock('node:fs/promises',async importOriginal=>{
  const fs=await importOriginal<typeof import('node:fs/promises')>();
  return {...fs,readFile:(file:unknown,...options:unknown[])=>{
    if(String(file)===reads.forbidden)throw new Error('EVIDENCE_READ_BEFORE_SIZE_GUARD');
    return Reflect.apply(fs.readFile,fs,[file,...options]);
  }};
});
const roots:string[]=[];
afterEach(async()=>{reads.forbidden='';await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'repair-projection-')));roots.push(root);
  await mkdir(join(root,'blobs'));await writeFile(join(root,'blobs/article'),'captured');
  const manifest={version:'paideia.repair-parent.v1',files:[{path:'blobs/article',sha256:repairDigest('captured'),size:8}]};
  const receipt={parent:{root,manifestDigest:''}} as MeasurementRepairReceipt;
  const save=async()=>{const bytes=JSON.stringify(manifest);await writeFile(join(root,'projection-manifest.json'),bytes);receipt.parent.manifestDigest=repairDigest(bytes);};
  await save();return{root,manifest,receipt,save};
}
it('accepts an exact capture projection without changing any bytes',async()=>{
  const f=await fixture(),before=await readFile(join(f.root,'projection-manifest.json'));await verifyRepairProjection(f.receipt);
  expect(await readFile(join(f.root,'projection-manifest.json'))).toEqual(before);
  expect(await readFile(join(f.root,'blobs/article'),'utf8')).toBe('captured');
});
it.each(['../outside','/absolute','blobs/../outside','blobs//article','blobs/./article','blobs\\article','runtime/auth','checkpoint/foreign.json'])('rejects unauthorised path %s',async path=>{
  const f=await fixture();f.manifest.files[0]!.path=path;await f.save();await expect(verifyRepairProjection(f.receipt)).rejects.toThrow('Unsafe');
});
it('rejects duplicate declared paths and aggregate oversize without reading their bodies',async()=>{
  const f=await fixture();f.manifest.files.push({...f.manifest.files[0]!});await f.save();
  await expect(verifyRepairProjection(f.receipt)).rejects.toThrow('duplicate');
  f.manifest.files=Array.from({length:9},(_,index)=>({path:`blobs/${index}`,size:67108864,sha256:repairDigest('x')}));await f.save();
  await expect(verifyRepairProjection(f.receipt)).rejects.toThrow('512 MiB');
});
it.each(['extra','missing','bytes','size','digest'])('rejects %s captured evidence drift',async kind=>{
  const f=await fixture();
  if(kind==='extra')await writeFile(join(f.root,'blobs/extra'),'extra');
  if(kind==='missing')await rm(join(f.root,'blobs/article'));
  if(kind==='bytes')await writeFile(join(f.root,'blobs/article'),'tampered');
  if(kind==='size'){f.manifest.files[0]!.size=7;await f.save();}
  if(kind==='digest'){f.manifest.files[0]!.sha256=repairDigest('different');await f.save();}
  await expect(verifyRepairProjection(f.receipt)).rejects.toThrow(/file set|evidence bytes|size or kind/);
});
it.each(['manifest-link','file-link','directory-link','fifo','deep'])('rejects unsafe %s structure',async kind=>{
  const f=await fixture();
  if(kind==='manifest-link'){await rm(join(f.root,'projection-manifest.json'));await symlink(join(f.root,'blobs/article'),join(f.root,'projection-manifest.json'));}
  if(kind==='file-link'){await rm(join(f.root,'blobs/article'));await symlink('../projection-manifest.json',join(f.root,'blobs/article'));}
  if(kind==='directory-link')await symlink('blobs',join(f.root,'alias'));
  if(kind==='fifo')await promisify(execFile)('mkfifo',[join(f.root,'fifo')]);
  if(kind==='deep'){let dir=f.root;for(let index=0;index<18;index++){dir=join(dir,'nested');await mkdir(dir);}}
  await expect(verifyRepairProjection(f.receipt)).rejects.toThrow(/Unsafe|symlink|non-file|bounds/);
});
it.each(['manifest-digest','manifest-oversize','malformed','extra-field','empty'])('rejects %s manifests',async kind=>{
  const f=await fixture(),path=join(f.root,'projection-manifest.json');
  if(kind==='manifest-digest')f.receipt.parent.manifestDigest=repairDigest('bad');
  if(kind==='manifest-oversize')await truncate(path,2097153);
  if(kind==='malformed'){await writeFile(path,'{bad');f.receipt.parent.manifestDigest=repairDigest('{bad');}
  if(kind==='extra-field'){Object.assign(f.manifest,{extra:true});await f.save();}
  if(kind==='empty'){f.manifest.files=[];await f.save();}
  await expect(verifyRepairProjection(f.receipt)).rejects.toThrow();
});


it('rejects oversized evidence before allocating its body',async()=>{
  const f=await fixture(),file=join(f.root,'blobs/article');
  await truncate(file,67108865);reads.forbidden=file;
  await expect(verifyRepairProjection(f.receipt)).rejects.toThrow('size or kind');
});
