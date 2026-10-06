import { afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
const databases: Database[] = [];
export function observerTaskFixture() {
  const db = new Database(':memory:');
  databases.push(db);
  const store = new ObserverTaskStore(db);
  return { getObserverTaskStore: () => store };
}
afterAll(() => { for (const db of databases) db.close(); });
