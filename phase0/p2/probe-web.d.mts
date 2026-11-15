/** Types for the sibling probe-web.mjs (operator web probe, plain node). */
export const PROBE_SERVICE: string;
export function routeRequest(
  url: string,
  client: { retrieveWorkflow(id: string): { getStatus(): Promise<unknown> } },
): Promise<[number, unknown]>;
