/**
 * D1 implementation of the `Sql` interface.
 *
 * This is the only file allowed to know about D1. Swapping in Postgres means
 * writing a sibling of this file, not touching the scheduler.
 */
import type { Sql, SqlResult } from './store';

interface D1Result<T> {
  results?: T[];
  meta?: { changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result<unknown>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
  exec(query: string): Promise<unknown>;
}

export class D1Sql implements Sql {
  constructor(private readonly db: D1Database) {}

  private stmt(query: string, params: unknown[] = []) {
    const prepared = this.db.prepare(query);
    return params.length > 0 ? prepared.bind(...params) : prepared;
  }

  async all<T>(query: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.stmt(query, params).all<T>();
    return result.results ?? [];
  }

  async first<T>(query: string, params: unknown[] = []): Promise<T | null> {
    return this.stmt(query, params).first<T>();
  }

  async run(query: string, params: unknown[] = []): Promise<SqlResult> {
    const result = await this.stmt(query, params).run();
    return { changes: result.meta?.changes ?? 0 };
  }

  async batch(statements: { query: string; params?: unknown[] }[]): Promise<SqlResult[]> {
    const prepared = statements.map((s) => this.stmt(s.query, s.params ?? []));
    const results = await this.db.batch(prepared);
    return results.map((r) => ({ changes: r.meta?.changes ?? 0 }));
  }
}
