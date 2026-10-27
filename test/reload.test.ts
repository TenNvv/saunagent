import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

async function launchFixture(code: string) {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-launcher-'));
  try {
    mkdirSync(join(directory, 'src'));
    symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, rootDir: 'src', types: ['node'] }, include: ['src/**/*.ts'] }));
    const source = join(directory, 'src/cli.ts');
    writeFileSync(source, code);
    const entry = join(directory, 'start.mjs');
    writeFileSync(entry, `import {main} from ${JSON.stringify(pathToFileURL(resolve('scripts/start.mjs')).href)}; await main(${JSON.stringify([source])},${JSON.stringify(directory)});`);
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('launcher timed out: ' + output)); }, 55000);
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timeout); resolveResult({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(readdirSync(directory).some(name => name.startsWith('.saunagent-build-')), false);
    return result.output;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('launcher builds latest source, survives a failed reload, and starts the corrected version without another npm start', { timeout: 60000 }, async () => {
  const output = await launchFixture(`import {readFileSync,writeFileSync} from 'node:fs';
const version = Number(1);
process.send!({type:'ready'});
if (version === 1) {
  console.log('OLD_WORKER_READY');
  const source=process.argv[2]!;
  writeFileSync(source, readFileSync(source,'utf8')+"\\nconst broken: number = 'bad';\\n");
  process.send!({type:'reload'});
  process.on('message', (raw:unknown)=>{
    const event=raw as {type:string;success?:boolean};
    if(event.type!=='reload-result') return;
    if(!event.success){
      console.log('BUILD_REJECTED_OLD_WORKER_ALIVE');
      const text=readFileSync(source,'utf8').replace("const version = Number(1);","const version = Number(2);").replace("const broken: number = 'bad';",'');
      writeFileSync(source,text); process.send!({type:'reload'});
    }else{process.exitCode=75;process.disconnect();}
  });
} else {console.log('NEW_VERSION_READY');process.disconnect();}
`);
  assert.match(output, /OLD_WORKER_READY/);
  assert.match(output, /BUILD_REJECTED_OLD_WORKER_ALIVE/);
  assert.match(output, /NEW_VERSION_READY/);
});

test('launcher rolls back a version that compiles but crashes before the TUI is ready', { timeout: 60000 }, async () => {
  const output = await launchFixture(`import {readFileSync,writeFileSync} from 'node:fs';
const version = Number(1);
if(version===2) throw new Error('INTENTIONAL_NEW_VERSION_STARTUP_FAILURE');
process.send!({type:'ready'});
if(version===3){console.log('RECOVERED_NEW_VERSION_READY');process.disconnect();}
else{
  const source=process.argv[2]!;
  const text=readFileSync(source,'utf8');
  if(/^const version = Number[(]2[)];/m.test(text)){
    console.log('OLD_VERSION_RESTORED');
    writeFileSync(source,text.replace('const version = Number(2);','const version = Number(3);'));
  }else{
    writeFileSync(source,text.replace('const version = Number(1);','const version = Number(2);'));
  }
  process.on('message',(raw:unknown)=>{
    const event=raw as {type:string;success?:boolean};
    if(event.type==='reload-result'&&event.success){process.exitCode=75;process.disconnect();}
  });
  process.send!({type:'reload'});
}
`);
  assert.match(output, /INTENTIONAL_NEW_VERSION_STARTUP_FAILURE/);
  assert.match(output, /OLD_VERSION_RESTORED/);
  assert.match(output, /RECOVERED_NEW_VERSION_READY/);
});
