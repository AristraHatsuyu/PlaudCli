'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {downloadFile, outputNameFor} = require('../lib/download');

test('download streams, follows redirects, preserves existing files and cleans partial failures', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'plaud-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const server = http.createServer((req,res)=>{
    if(req.url === '/redirect') {res.writeHead(302,{location:'/audio.mp3'}); return res.end();}
    if(req.url === '/broken') {res.writeHead(200,{'content-length':'100'});res.write('partial');return setImmediate(()=>res.destroy());}
    res.end('synthetic-audio');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(dir,'recording.mp3'),'existing');
  const client = {getTemporaryUrl:async()=>base+'/redirect'};
  const output = await downloadFile(client,{id:'test',filename:'recording.mp3'},dir);
  assert.equal(await fs.readFile(output,'utf8'),'synthetic-audio');
  assert.equal(await fs.readFile(path.join(dir,'recording.mp3'),'utf8'),'existing');
  client.getTemporaryUrl = async()=>base+'/broken';
  await assert.rejects(downloadFile(client,{id:'broken'},dir));
  assert.equal((await fs.readdir(dir)).some(name=>name.endsWith('.part')),false);
});
test('filenames cannot escape download directory',()=>{
  const name = outputNameFor({filename:'../../private'},'https://example.test/a.mp3');
  assert.equal(name.includes('/'),false);
  assert.equal(name.endsWith('.mp3'),true);
});
