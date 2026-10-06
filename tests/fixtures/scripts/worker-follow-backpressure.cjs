const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {setTimeout:sleep}=require('node:timers/promises');
const pollDelay=Number(process.argv[2]);
(async()=>{
  const home=mkdtempSync(join(tmpdir(),'claude-mem-follow-chunks-'));
  const stamp=new Date().toISOString().slice(0,10);
  const log=join(home,'.claude-mem','logs',`claude-mem-${stamp}.log`);
  mkdirSync(join(home,'.claude-mem','logs'),{recursive:true});
  writeFileSync(log,'before\n');
  const preload=join(home,'trace.cjs');
  // Observe actual filesystem calls; every read still executes the native
  // implementation against the owned log. No synthetic read result is used.
  writeFileSync(preload, `
    const fs=require('fs');const owned=new Set();
    const open=fs.openSync,read=fs.readSync,close=fs.closeSync,watch=fs.watchFile;
    fs.watchFile=function(path,options,listener){
      return watch.call(this,path,options,(...args)=>{
        const size=args[0].size,firstBurst=Number(process.env.OWNED_FIRST_BURST_SIZE);
        process.stderr.write('NATIVE_POLL_SIZE:'+size+'\\n');
        // Queue a pre-second-burst snapshot ahead of its newer snapshot.
        // Both are actual native events; only callback delivery is delayed.
        const delay=Number(process.env.OWNED_POLL_DELAY_MS)
          ? size>firstBurst?2000:size===firstBurst?1200:650 : 0;
        setTimeout(()=>{listener(...args);process.stderr.write('POLL_DELIVERED\\nPOLL_SIZE:'+size+'\\n');},delay);
      });
    };
    fs.openSync=function(path,...args){const fd=open.call(this,path,...args);if(String(path)===process.env.OWNED_LOG_PATH)owned.add(fd);return fd;};
    fs.readSync=function(fd,buffer,offset,length,position){if(owned.has(fd))process.stderr.write('READ_LENGTH:'+length+'\\n');return read.call(this,fd,buffer,offset,length,position);};
    fs.closeSync=function(fd){owned.delete(fd);return close.call(this,fd);};
  `);
  const child=spawn('node',['--require',preload,join(__dirname,'../../../scripts/worker-logs.cjs'),'--follow'],{
    env:{...process.env,HOME:home,USERPROFILE:home,CLAUDE_MEM_DATA_DIR:'',TZ:'UTC',OWNED_LOG_PATH:log,OWNED_POLL_DELAY_MS:String(pollDelay),OWNED_FIRST_BURST_SIZE:String(Buffer.byteLength('before\n'+'€ captured\n'.repeat(200000)))},
  });
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let output='',trace='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{trace+=chunk});
  const wait=async(predicate)=>{const end=Date.now()+10000;while(!predicate()){
    if(Date.now()>end)throw Error('Owned follower did not produce expected output: '+trace);await sleep(10);}};
  try{
    await wait(()=>output==='before\n');
    const burst='€ captured\n'.repeat(200000);
    child.stdout.pause();
    if(pollDelay){
      const firstHalf=burst.slice(0,burst.length/2);
      appendFileSync(log,firstHalf);
      await wait(()=>trace.includes('NATIVE_POLL_SIZE:'+Buffer.byteLength('before\n'+firstHalf)+'\n'));
      // Queue two real changes before the first delayed callback reaches the
      // follower. The latter stale callback can arrive after the second burst.
      await sleep(500);
      appendFileSync(log,burst.slice(burst.length/2));
    }else appendFileSync(log,burst);
    // Observe the native follow read before testing backpressure. Poll
    // delivery can be delayed by host scheduling without a reader defect.
    await wait(()=>[...trace.matchAll(/READ_LENGTH:(\d+)/g)].length>1);
    await sleep(350);
    const pausedReadLengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    assert.ok(pausedReadLengths.length>1);
    const bytesReadWhilePaused=pausedReadLengths.reduce((total,length)=>total+length,0);
    assert.ok(bytesReadWhilePaused<Buffer.byteLength(burst), 'paused native pipe must apply backpressure');
    const duringBackpressure='second burst €\n'.repeat(5000);
    const secondBurstSize=Buffer.byteLength('before\n'+burst+duringBackpressure);
    appendFileSync(log,duringBackpressure);
    await wait(()=>[...trace.matchAll(/^POLL_SIZE:(\d+)$/gm)].some(match=>Number(match[1])>=secondBurstSize));
    await sleep(350);
    // The second poll must stay behind the blocked write, not read ahead
    // into another in-memory queue while the consumer remains paused.
    const laterPollSizes=[...trace.matchAll(/^POLL_SIZE:(\d+)$/gm)].map(match=>Number(match[1]));
    assert.ok(laterPollSizes.includes(secondBurstSize));
    const laterReadLengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    assert.deepEqual(laterReadLengths,pausedReadLengths);
    child.stdout.resume();
    await wait(()=>output.length==='before\n'.length+burst.length+duringBackpressure.length);
    assert.equal(output,'before\n'+burst+duringBackpressure);
    const lengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    assert.ok(lengths.length>1);
    assert.ok(Math.max(...lengths)<=64*1024);
  }finally{
    const exited=child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',()=>resolve()));child.kill();await exited;
    rmSync(home,{recursive:true,force:true});
  }

console.log('NATIVE_BACKPRESSURE_OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
