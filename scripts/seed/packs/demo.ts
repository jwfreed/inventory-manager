import type { PoolClient } from 'pg';
import { runSiamayaFactoryPack, type SeedSummary } from './siamaya_factory';

export async function runDemoPack(client: PoolClient): Promise<SeedSummary> {
  return runSiamayaFactoryPack(client, {
    pack: 'demo',
    tenantSlug: 'demo',
    tenantName: 'Demo Tenant',
    warehouses: [
      { code: 'FACTORY', name: 'Factory' }
    ],
    datasetOverride: {
      items: [
        {
          key: 'demo finished good',
          name: 'Demo Finished Good',
          baseUom: 'piece',
          appearsAsOutput: true,
          appearsAsComponent: false
        },
        {
          key: 'demo raw material',
          name: 'Demo Raw Material',
          baseUom: 'piece',
          appearsAsOutput: false,
          appearsAsComponent: true
        }
      ],
      boms: [
        {
          outputKey: 'demo finished good',
          outputName: 'Demo Finished Good',
          outputQuantity: 1,
          outputUom: 'piece',
          components: [
            {
              componentKey: 'demo raw material',
              componentName: 'Demo Raw Material',
              quantity: 1,
              uom: 'piece',
              note: null,
              sequence: 1
            }
          ]
        }
      ],
      unknownUoms: []
    }
  });
}
