/** Build to an isolated candidate only. Never writes an installed plugin. */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
const sdk=resolve('artifacts/predeploy/sdk-0.3.261/node_modules/@anthropic-ai/claude-agent-sdk');
const version=JSON.parse(readFileSync(join(sdk,'package.json'),'utf8')).version;
if(version!=='0.3.261')throw Error('Candidate SDK must match verified runtime version');
const outfile=resolve('artifacts/predeploy/candidate/scripts/worker-service.cjs');
mkdirSync(dirname(outfile),{recursive:true});
const result=await build({
 entryPoints:['src/services/worker-service.ts'],bundle:true,platform:'node',target:'node18',format:'cjs',outfile,minify:true,metafile:true,logLevel:'error',
 alias:{'@anthropic-ai/claude-agent-sdk':join(sdk,'sdk.mjs')},
 external:['bun:sqlite','zod','cohere-ai','ollama','@chroma-core/default-embed','onnxruntime-node','better-auth','better-auth/node','better-auth/plugins','@better-auth/api-key'],
 define:{'__DEFAULT_PACKAGE_VERSION__':'"13.24.1"','import.meta.url':'__IMPORT_META_URL__'},
 banner:{js:'#!/usr/bin/env bun\nvar __filename = __filename || require("node:path").resolve(process.argv[1] || "");\nvar __dirname = __dirname || require("node:path").dirname(__filename);\nvar __IMPORT_META_URL__ = require("node:url").pathToFileURL(__filename).href;'},
});
// Same post-processing as scripts/build-hooks.js, to avoid embedding build paths.
let code=readFileSync(outfile,'utf8');
const str='(?:"[^"]*"|\'[^\']*\')';
for(const id of ['__dirname','__filename']){
 code=code.replace(new RegExp('\\bvar '+id+'\\s*=\\s*'+str+',\\s*','g'),'var ')
 .replace(new RegExp('\\bvar '+id+'\\s*=\\s*'+str+';\\s*','g'),'')
 .replace(new RegExp(',\\s*'+id+'\\s*=\\s*'+str,'g'),'');
}
code=code.replace(/\bvar\s*;/g,'').replace(/[ \t]+$/gm,'');writeFileSync(outfile,code);
const sha256=data=>createHash('sha256').update(data).digest('hex');
const inputs=Object.keys(result.metafile.inputs).map(path=>({path,sha256:sha256(readFileSync(path))}));
writeFileSync('artifacts/predeploy/candidate-manifest.json',JSON.stringify({outfile,sdkVersion:version,sdkSha256:sha256(readFileSync(join(sdk,'sdk.mjs'))),bundleSha256:sha256(code),inputs},null,2));
console.log(JSON.stringify({outfile,sdkVersion:version,bundleSha256:sha256(code),bytes:Buffer.byteLength(code),inputs:inputs.length}));
