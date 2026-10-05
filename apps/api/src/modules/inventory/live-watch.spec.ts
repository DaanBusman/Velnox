import { describe, expect, it } from 'vitest';
import { clustersIn } from './live-watch.interceptor';

const A = '7aca66b8-fce5-46e1-be80-46e89221de55';
const B = '3d8c7c82-fd61-4549-bc5f-a413f1b8da2b';

describe('clustersIn', () => {
  it('reads a cluster list by id, and other lists by their cluster', () => {
    expect(clustersIn({ clusters: [{ id: A }, { id: B }] }).sort()).toEqual([A, B].sort());
    expect(clustersIn({ workloads: [{ clusterId: A }, { clusterId: A }] })).toEqual([A]);
    expect(clustersIn({ nodes: [{ clusterId: B }] })).toEqual([B]);
    expect(clustersIn({ storages: [{ clusterId: A }] })).toEqual([A]);
  });

  it('reads a single node by its cluster and a single cluster by its id', () => {
    expect(clustersIn({ id: 'n', clusterId: A })).toEqual([A]);
    expect(clustersIn({ id: B, connectionState: 'CONNECTED' })).toEqual([B]);
  });

  it('records nothing it cannot recognise as a cluster id', () => {
    expect(clustersIn({ clusters: [{ id: 'x' }], nodes: [{ clusterId: 5 }] })).toEqual([]);
    expect(clustersIn(null)).toEqual([]);
    expect(clustersIn('text')).toEqual([]);
  });
});
