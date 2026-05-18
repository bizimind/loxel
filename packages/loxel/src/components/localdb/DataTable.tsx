import type { TableSchema } from "@bizimind/localdb-sdk";

import type { DataAdapter } from "@/components/localdb/ui";
import { DataTable as UIDataTable } from "@/components/localdb/ui";

interface Props {
  schema: TableSchema;
  adapter: DataAdapter;
  activeProjectPath: string;
}

/** Thin wrapper that connects the localdb table to the loxel project adapter. */
export function DataTable({ schema, adapter }: Props) {
  return <UIDataTable schema={schema} adapter={adapter} pageSize={50} />;
}
