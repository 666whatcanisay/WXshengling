// Test double only: JSON files stand in for CloudBase. No network or SDK calls.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

type Doc = Record<string, any>;
type Tables = Record<string, Record<string, Doc>>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class FileDb {
  private tables: Tables;
  private inTransaction = false;
  constructor(private path: string) {
    this.tables = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  }
  command = { lt: (value: unknown) => ({ $lt: value }) };
  private flush() {
    if (!this.inTransaction) writeFileSync(this.path, JSON.stringify(this.tables));
  }
  async createCollection(name: string) {
    if (this.tables[name]) throw Object.assign(new Error('exists'), { code: 'DATABASE_COLLECTION_ALREADY_EXIST' });
    this.tables[name] = {};
    this.flush();
  }
  collection(name: string) {
    if (!this.tables[name]) throw new Error(`Missing test collection: ${name}`);
    return {
      doc: (id: string) => ({ set: async (data: Doc) => {
        this.tables[name][id] = clone({ ...data, _id: id });
        this.flush();
      } }),
      where: (filter: Doc) => {
        let orderKey = '', descending = false, offset = 0, count = 100;
        const matches = (doc: Doc) => Object.entries(filter).every(([key, expected]) => {
          const actual = key.split('.').reduce((v: any, k) => v?.[k], doc);
          return expected && typeof expected === 'object' && '$lt' in expected
            ? actual < expected.$lt : actual === expected;
        });
        const query = {
          orderBy: (key: string, direction: string) => { orderKey = key; descending = direction === 'desc'; return query; },
          skip: (value: number) => { offset = value; return query; },
          limit: (value: number) => { count = value; return query; },
          get: async () => {
            let docs = Object.values(this.tables[name]).filter(matches);
            if (orderKey) docs.sort((a, b) => {
              const comparison = a[orderKey] < b[orderKey] ? -1 : a[orderKey] > b[orderKey] ? 1 : 0;
              return descending ? -comparison : comparison;
            });
            return { data: clone(docs.slice(offset, offset + count)) };
          },
          remove: async () => {
            for (const [id, doc] of Object.entries(this.tables[name])) if (matches(doc)) delete this.tables[name][id];
            this.flush();
          }
        };
        return query;
      }
    };
  }
  // An in-process rollback stub, NOT evidence of real database transactions.
  async runTransaction<T>(callback: (transaction: FileDb) => Promise<T>): Promise<T> {
    const before = clone(this.tables);
    this.inTransaction = true;
    try { return await callback(this); }
    catch (error) { this.tables = before; throw error; }
    finally { this.inTransaction = false; this.flush(); }
  }
}
