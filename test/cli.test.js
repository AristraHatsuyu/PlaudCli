'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const cli = path.resolve(__dirname,'../plaudcli.js');
test('CLI help, invalid arguments and isolated local logout',async t=>{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'plaud-cli-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const run = (...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,PLAUDCLI_CONFIG_DIR:dir}});
  assert.equal(run('--help').status,0);
  assert.equal(run('--invalid').status,1);
  await fs.writeFile(path.join(dir,'session.json'),'{}');
  assert.equal(run('--logout').status,0);
  await assert.rejects(fs.access(path.join(dir,'session.json')));
  assert.equal(run('--logout').status,0);
});
