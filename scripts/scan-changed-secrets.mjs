import{execFileSync}from'node:child_process';import{readFile}from'node:fs/promises'
const output=execFileSync('git',['status','--porcelain=v1','-z'],{encoding:'utf8'})
const paths=[];for(const record of output.split('\0')){if(!record)continue;const path=record.slice(3);if(path&&!path.includes(' -> ')&&!path.startsWith('.env.local'))paths.push(path)}
const rules=[['private key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],['Supabase secret key',/sb_secret_[A-Za-z0-9_-]{20,}/],['JWT',/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],['database credential URL',/postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/i]]
let failed=false;for(const path of paths){const content=await readFile(path,'utf8').catch(()=>null);if(content===null)continue;for(const[label,pattern]of rules)if(pattern.test(content)){failed=true;console.error(`${path}: possible ${label}`)}}
if(failed)process.exit(1);console.log(`Changed-file secret scan passed (${paths.length} files; values were not printed).`)
