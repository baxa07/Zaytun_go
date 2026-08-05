import{execFileSync}from'node:child_process';import{readFile}from'node:fs/promises'
const git=(args)=>execFileSync('git',args,{encoding:'utf8'}).split('\0').filter(Boolean)
const paths=[...new Set([...git(['diff','--name-only','-z']),...git(['diff','--cached','--name-only','-z']),...git(['ls-files','--others','--exclude-standard','-z'])])].filter(path=>!path.startsWith('.env.local'))
const rules=[['private key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],['Supabase secret key',/sb_secret_[A-Za-z0-9_-]{20,}/],['JWT',/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],['database credential URL',/postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/i]]
let failed=false;for(const path of paths){const content=await readFile(path,'utf8').catch(()=>null);if(content===null)continue;for(const[label,pattern]of rules)if(pattern.test(content)){failed=true;console.error(`${path}: possible ${label}`)}}
if(failed)process.exit(1);console.log(`Changed-file secret scan passed (${paths.length} files; values were not printed).`)
