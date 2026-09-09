/** Read-only comparison of installed code with the recorded release chain. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import ts from 'typescript';
const artifacts='/Users/mac/workspace_codex/claude-mem-slot-fairness/artifacts';
const live='/Users/mac/.claude/plugins/cache/thedotmack/claude-mem/13.24.1/scripts/worker-service.cjs';
const digest=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const current=readFileSync(live,'utf8'), original=readFileSync(join(artifacts,'worker-service.original.cjs'),'utf8');
function declarations(code:string){
 const tree=ts.createSourceFile('bundle.js',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const map=new Map<string,string>();
 // Top-level statements isolate third-party declarations from injected helpers.
 for(const statement of tree.statements){
  if(ts.isFunctionDeclaration(statement)&&statement.name)map.set('function '+statement.name.text,statement.getText(tree));
  else if(ts.isVariableStatement(statement))for(const d of statement.declarationList.declarations)map.set('var '+d.name.getText(tree),d.getText(tree));
  else if(ts.isClassDeclaration(statement)&&statement.name)map.set('class '+statement.name.text,statement.getText(tree));
 }
 return map;
}
const before=declarations(original), after=declarations(current);
const changed=[...before].filter(([k,v])=>after.get(k)!==v).map(([name,code])=>({name,before:digest(code),after:after.has(name)?digest(after.get(name)!):null}));
const added=[...after.keys()].filter(k=>!before.has(k));
const checkpoints=[];
for(const name of readdirSync(artifacts)){
 if(!/installed-backup/.test(name))continue;
 try{const rows=JSON.parse(readFileSync(join(artifacts,name,'manifest.json'),'utf8'));checkpoints.push({directory:name,files:rows.map((r:any)=>({target:r.target,recorded:r.sha256 ?? r.before,actual:digest(readFileSync(r.backup))}))});}catch{}
}
const result={livePath:live,liveSha256:digest(current),originalSha256:digest(original),finalRecordedArtifactMatches:current===readFileSync(join(artifacts,'worker-service.release-source-recovery.cjs'),'utf8'),sdkVersionLiterals:[...new Set(current.match(/0\.3\.\d+/g))],originalTopLevelDeclarations:before.size,unchanged:[...before].filter(([k,v])=>after.get(k)===v).length,changed,added,checkpoints};
writeFileSync('artifacts/predeploy/runtime-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,checkpoints:checkpoints.map(x=>({directory:x.directory,allHashesMatch:x.files.every((f:any)=>f.recorded===f.actual)}))},null,2));
