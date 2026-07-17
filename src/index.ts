import { createHealthApiServer } from './http.js';
import { configuredStore } from './configured-store.js';

const port = Number(process.env.PORT ?? '8787');

async function main(): Promise<void> {
  const mode = (process.env.STORE_MODE ?? 'postgres').toLowerCase();
  // Apply schema migrations on boot for the durable store so a fresh
  // `docker compose up` is immediately usable. Opt out with RUN_MIGRATIONS=false
  // when a separate migrate step owns the schema.
  if (mode === 'postgres' && (process.env.RUN_MIGRATIONS ?? 'true').toLowerCase() !== 'false') {
    const { runMigrations } = await import('./db/migrate.js');
    const result = await runMigrations();
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'migrations_ready', applied: result.applied.length, skipped: result.skipped.length }));
  }

  const server = createHealthApiServer(configuredStore());
  server.listen(port, () => {
    console.log(`ForeverBetter API listening on http://localhost:${port}`);
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
