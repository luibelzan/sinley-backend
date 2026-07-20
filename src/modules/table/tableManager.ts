import { Table } from "./table";

const tables = new Map<string, Table>();

export function getOrCreateTable(tableId: string): Table {
  let table = tables.get(tableId);
  if (!table) {
    table = new Table(tableId);
    tables.set(tableId, table);
  }
  return table;
}

export function getTable(tableId: string): Table | undefined {
  return tables.get(tableId);
}
