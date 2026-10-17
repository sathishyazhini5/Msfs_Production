// Optional embedded outbox runner; SMTP is disabled unless explicitly configured.
export function createMemberWelcomeRuntime({ db, service, enabled, mailReady, log = console, pollMs = 10000 }) {
  let loop, stopping = false, wake;
  return {
    start() {
      if (loop || !enabled() || !mailReady()) return;
      loop = (async () => {
        while (!stopping) {
          try {
            await service.recover();
            const rows = await db.memberAccess.findMany({ where: { enabled: true, password_changed_at: null, welcome_status: { in: ['Pending', 'Retryable'] } }, select: { user_id: true }, take: 100 });
            for (const row of rows) { if (stopping) break; await service.deliver(row.user_id); }
          } catch (error) { log.error(`Member welcome worker error: ${error.code || error.name}`); }
          if (!stopping) await new Promise(resolve => {
            const timer = setTimeout(resolve, pollMs);
            wake = () => { clearTimeout(timer); resolve(); };
          });
        }
      })();
    },
    async stop() { stopping = true; wake?.(); await loop; },
  };
}
