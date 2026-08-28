export const RUNTIME_LINK_MATERIALIZER_PATH = "/opt/spawnfile/materialize-runtime-links.cjs";

export const renderRuntimeLinkMaterializer = (): string => `"use strict";
const fs=require("node:fs"),path=require("node:path"),root=path.resolve(process.argv[2]||"");
if(!root.startsWith("/opt/spawnfile/runtime-installs/"))throw Error("unsafe root");
const rootInfo=fs.lstatSync(root),links=[];
if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||rootInfo.uid||rootInfo.gid)throw Error("unsafe root identity");
const walk=d=>{for(const n of fs.readdirSync(d).sort()){const p=path.join(d,n),s=fs.lstatSync(p);if(s.isSymbolicLink())links.push(p);else if(s.isDirectory())walk(p);else if(!s.isFile())throw Error("unsupported entry");}};
const inside=p=>p.startsWith(root+path.sep);
const resolve=p=>{let hops=0;for(;;){const rel=path.relative(root,p);if(!rel||rel.startsWith("..")||path.isAbsolute(rel))throw Error("link escape");const parts=rel.split(path.sep);let q=root,again=false;for(let i=0;i<parts.length;i++){q=path.join(q,parts[i]);const s=fs.lstatSync(q);if(!s.isSymbolicLink())continue;if(++hops>16||s.uid||s.gid)throw Error("unsafe link chain");const l=fs.readlinkSync(q);if(path.isAbsolute(l))throw Error("absolute link");p=path.resolve(path.dirname(q),l,...parts.slice(i+1));if(!inside(p))throw Error("link escape");again=true;break;}if(!again)return p;}};
walk(root);
for(const link of links){const s=fs.lstatSync(link);if(!s.isSymbolicLink()||s.uid||s.gid)throw Error("link changed");const target=resolve(link),t=fs.lstatSync(target);if(!t.isFile()||t.isSymbolicLink()||t.uid||t.gid||t.dev!==rootInfo.dev||t.nlink<1)throw Error("unsafe target");const b=fs.readFileSync(target);if(b.length>67108864)throw Error("target too large");const tmp=link+".spawnfile-materialize",fd=fs.openSync(tmp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,t.mode&0o111?0o555:0o444);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,link);}
`;
