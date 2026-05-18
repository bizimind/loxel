import type { TableSchema, GraphViewDef } from "@bizimind/localdb-sdk";
import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

import type { DataAdapter } from "../../adapters/data-adapter.ts";

interface Props {
  schema: TableSchema;
  viewDef: GraphViewDef;
  adapter: DataAdapter;
}

type Row = Record<string, unknown>;

const COLORS = ["#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2", "#db2777"];

export function GraphView({ schema, viewDef, adapter }: Props) {
  const { xColumn, yColumn, chartKind, groupByColumn } = viewDef;
  const tableName = schema.table.name;

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adapter
      .query<Row>(tableName, { pageSize: 1000 })
      .then((p) => {
        setRows(p.rows);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [tableName]);

  if (loading) {
    return <div className="text-muted-foreground p-4 text-xs">Loading…</div>;
  }

  if (rows.length === 0) {
    return <div className="text-muted-foreground p-4 text-center text-xs">No data to display</div>;
  }

  if (chartKind === "pie") {
    const data = rows.map((r) => ({
      name: String(r[xColumn] ?? ""),
      value: Number(r[yColumn] ?? 0),
    }));
    return (
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" label>
            {data.map((_entry, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  // For bar/line/scatter: build dataset
  let seriesKeys: string[];
  let chartData: Record<string, unknown>[];

  if (groupByColumn) {
    const groups = [...new Set(rows.map((r) => String(r[groupByColumn] ?? "other")))];
    seriesKeys = groups;
    const xVals = [...new Set(rows.map((r) => String(r[xColumn] ?? "")))];
    chartData = xVals.map((xVal) => {
      const entry: Record<string, unknown> = { [xColumn]: xVal };
      for (const g of groups) {
        const match = rows.find(
          (r) => String(r[xColumn] ?? "") === xVal && String(r[groupByColumn] ?? "other") === g,
        );
        entry[g] = match ? Number(match[yColumn] ?? 0) : 0;
      }
      return entry;
    });
  } else {
    seriesKeys = [yColumn];
    chartData = rows.map((r) => ({
      [xColumn]: String(r[xColumn] ?? ""),
      [yColumn]: Number(r[yColumn] ?? 0),
    }));
  }

  const commonProps = { data: chartData };
  const axisProps = { dataKey: xColumn };

  if (chartKind === "bar") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis {...axisProps} />
          <YAxis />
          <Tooltip />
          {seriesKeys.length > 1 && <Legend />}
          {seriesKeys.map((k, i) => (
            <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chartKind === "line") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <LineChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis {...axisProps} />
          <YAxis />
          <Tooltip />
          {seriesKeys.length > 1 && <Legend />}
          {seriesKeys.map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={COLORS[i % COLORS.length]}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // scatter
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ScatterChart>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={xColumn} type="number" name={xColumn} />
        <YAxis dataKey={yColumn} type="number" name={yColumn} />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} />
        {seriesKeys.length > 1 && <Legend />}
        {seriesKeys.map((k, i) => (
          <Scatter
            key={k}
            name={k}
            data={chartData.map((r) => ({ [xColumn]: r[xColumn], [yColumn]: r[k] }))}
            fill={COLORS[i % COLORS.length]}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}
