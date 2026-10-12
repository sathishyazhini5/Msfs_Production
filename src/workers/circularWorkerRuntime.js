// Shared lifecycle for the embedded API worker and optional standalone worker.
export function createCircularWorkerRuntime({db,queue,enabled,mailReady,log=console,pollMs=2000}) {
  let startup,loop,shutdown,stopping=false,wake;
  const pause=()=>new Promise(resolve=>{
    const timer=setTimeout(()=>{wake=null;resolve();},pollMs);
    wake=()=>{clearTimeout(timer);wake=null;resolve();};
  });
  return {
    start() {
      if(startup)return startup;
      startup=(async()=>{
        if(stopping || !enabled())return false;
        if(!mailReady()){log.error('Circular worker unavailable: configure GMAIL_USER and GMAIL_PASS.');return false;}
        await db.$connect();
        if(stopping)return false;
        log.info('Circular worker started. SMTP acceptance is recorded as Sent; delivery is not assumed.');
        loop=(async()=>{
          while(!stopping){
            try {const count=await queue.runOnce();if(count)continue;}
            catch(error){log.error(`Circular queue error: ${error.code || error.name}`);}
            if(!stopping)await pause();
          }
        })();
        return true;
      })();
      return startup;
    },
    stop() {
      if(shutdown)return shutdown;
      stopping=true;wake?.();
      shutdown=(async()=>{
        try {await startup;}catch {} // Database initialization may have failed.
        try {await loop;}finally {await db.$disconnect();}
      })();
      return shutdown;
    }
  };
}
