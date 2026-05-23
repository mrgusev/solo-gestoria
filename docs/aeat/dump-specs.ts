// One-off script to dump AEAT record-design XLSX/XLS specs to readable text.
//   npx tsx docs/aeat/dump-specs.ts
import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "node:fs";

function dump(srcPath: string, outPath: string): void {
  const buf = readFileSync(srcPath);
  const wb = XLSX.read(buf, { type: "buffer" });
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    out.push(`=== SHEET: ${sheetName} ===`);
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown>(sheet, { header: 1, defval: "" });
    for (const row of rows as unknown[][]) {
      out.push(row.map((c) => String(c)).join("\t"));
    }
    out.push("");
  }
  writeFileSync(outPath, out.join("\n"));
  console.log(`Wrote ${outPath} (${out.length} lines)`);
}

dump("docs/aeat/DR303e26v101.xlsx", "docs/aeat/DR303e26v101.txt");
dump("docs/aeat/DR130e15v12.xls", "docs/aeat/DR130e15v12.txt");
