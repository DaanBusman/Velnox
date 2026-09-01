import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Container health check for the web service.
 *
 * Liveness only: it deliberately does not call the API. If it did, an API
 * restart would mark the web container unhealthy and Docker would restart a
 * process that was working perfectly well.
 */
export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok', service: 'web' });
}
