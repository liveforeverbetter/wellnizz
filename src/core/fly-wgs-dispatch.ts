/**
 * Starts the one pre-provisioned WGS Machine when durable queue work arrives.
 *
 * The API deliberately does not create an unbounded Machine per request. A
 * stopped worker in the reference-volume region gives us one idempotent start
 * target, one mounted dbSNP cache, and a predictable 4 GB capacity boundary.
 */

export type WgsDispatchOutcome =
  | { state: 'disabled'; message: string }
  | { state: 'not_configured'; message: string }
  | { state: 'already_running'; message: string }
  | { state: 'started'; message: string }
  | { state: 'capacity_unavailable'; message: string };

interface FlyMachine {
  state?: string;
}

export async function dispatchQueuedWgsWorker(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<WgsDispatchOutcome> {
  if (env.WGS_DISPATCH_ENABLED !== 'true') {
    return { state: 'disabled', message: 'Analysis is queued; dedicated WGS dispatch is not enabled on this deployment.' };
  }

  const app = env.WGS_WORKER_APP ?? env.FLY_APP_NAME;
  const machineId = env.WGS_WORKER_MACHINE_ID;
  const token = env.FLY_MACHINE_API_TOKEN;
  if (!app || !machineId || !token) {
    return { state: 'not_configured', message: 'Analysis is queued; the dedicated WGS worker is not yet configured.' };
  }

  const apiBase = (env.FLY_MACHINE_API_HOST ?? 'https://api.machines.dev').replace(/\/$/, '');
  const machineUrl = `${apiBase}/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  try {
    const machineResponse = await fetcher(machineUrl, { headers });
    if (!machineResponse.ok) {
      return capacityUnavailable(machineResponse.status, 'The dedicated WGS worker could not be inspected.');
    }
    const machine = await machineResponse.json() as FlyMachine;
    if (machine.state === 'started' || machine.state === 'starting') {
      return { state: 'already_running', message: 'A dedicated WGS worker is already preparing queued analysis.' };
    }
    if (machine.state !== 'stopped' && machine.state !== 'suspended') {
      return capacityUnavailable(409, `The dedicated WGS worker is currently ${machine.state ?? 'unavailable'}.`);
    }

    const startResponse = await fetcher(`${machineUrl}/start`, { method: 'POST', headers });
    if (startResponse.ok || startResponse.status === 409) {
      return { state: 'started', message: 'Dedicated WGS worker requested; preparing capacity in the worker region.' };
    }
    return capacityUnavailable(startResponse.status, 'Worker capacity could not be started in the configured region.');
  } catch {
    return { state: 'capacity_unavailable', message: 'Analysis is queued; worker capacity could not be reached and will need an operator retry.' };
  }
}

function capacityUnavailable(status: number, fallback: string): WgsDispatchOutcome {
  const capacityStatus = status === 408 || status === 409 || status === 422 || status >= 500;
  return {
    state: 'capacity_unavailable',
    message: capacityStatus
      ? 'Analysis is queued; the WGS worker region currently has no start capacity. We will retry when capacity is available.'
      : fallback,
  };
}
